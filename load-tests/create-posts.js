import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const USERS_URL = __ENV.USERS_URL || 'http://localhost:3001';
const USERNAME_PREFIX = __ENV.USERNAME_PREFIX || 'k6_demo_user';
const PASSWORD = __ENV.PASSWORD || 'demo_pass';
const POSTS_COUNT = Number(__ENV.POSTS_COUNT || 30);
const VUS = Number(__ENV.VUS || 1);
const POLL_STATUS = String(__ENV.POLL_STATUS || 'false').toLowerCase() === 'true';
const STATUS_TIMEOUT_MS = Number(__ENV.STATUS_TIMEOUT_MS || 60000);
const STATUS_POLL_INTERVAL_MS = Number(__ENV.STATUS_POLL_INTERVAL_MS || 1000);

export const options = {
  vus: VUS,
  iterations: VUS,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    demo_post_create_failed: ['count==0']
  }
};

export const demo_posts_created = new Counter('demo_posts_created');
export const demo_post_create_failed = new Counter('demo_post_create_failed');
export const demo_moderation_decision_duration = new Trend('demo_moderation_decision_duration', true);

function endpointTags(endpoint) {
  return { tags: { endpoint } };
}

function registerUser(username) {
  const payload = JSON.stringify({
    username,
    password: PASSWORD,
    displayName: `k6 ${username}`
  });

  const response = http.post(`${USERS_URL}/register`, payload, {
    headers: { 'Content-Type': 'application/json' },
    ...endpointTags('users_register')
  });

  check(response, {
    'register: accepted/exists': (r) => r.status === 201 || r.status === 200 || r.status === 409
  });
}

function login(username) {
  const response = http.post(`${USERS_URL}/login`, JSON.stringify({ username, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    ...endpointTags('users_login')
  });

  const ok = check(response, {
    'login: status 200': (r) => r.status === 200,
    'login: token present': (r) => Boolean(r.json('token'))
  });

  if (!ok) {
    return null;
  }

  return response.json('token');
}

function pollStatus(postId, authHeaders, createTimestampMs) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;

  while (Date.now() <= deadline) {
    const response = http.get(`${BASE_URL}/posts/${postId}/status`, {
      headers: authHeaders,
      ...endpointTags('posts_status')
    });

    if (response.status === 404 || response.status === 405) {
      return;
    }

    const ok = check(response, {
      'status poll: status 200': (r) => r.status === 200
    });

    if (!ok) {
      sleep(STATUS_POLL_INTERVAL_MS / 1000);
      continue;
    }

    const status = response.json('status');
    if (status && status !== 'PENDING_CLASSIFICATION') {
      const updatedAt = response.json('updatedAt');
      const decisionTs = Date.parse(updatedAt);
      if (Number.isFinite(decisionTs)) {
        demo_moderation_decision_duration.add(decisionTs - createTimestampMs, { status });
      }
      return;
    }

    sleep(STATUS_POLL_INTERVAL_MS / 1000);
  }
}

export default function () {
  const username = `${USERNAME_PREFIX}_${__VU}_${Date.now()}`;

  registerUser(username);

  const token = login(username);
  if (!token) {
    demo_post_create_failed.add(POSTS_COUNT, { endpoint: 'users_login' });
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  for (let i = 0; i < POSTS_COUNT; i += 1) {
    const createStartedMs = Date.now();
    const response = http.post(
      `${BASE_URL}/posts`,
      JSON.stringify({ text: `k6 demo post #${i + 1} ${username} ${createStartedMs}` }),
      {
        headers,
        ...endpointTags('posts_create')
      }
    );

    const created = check(response, {
      'post create: status 202': (r) => r.status === 202,
      'post create: id present': (r) => Boolean(r.json('id'))
    });

    if (created) {
      demo_posts_created.add(1, { endpoint: 'posts_create' });

      if (POLL_STATUS) {
        const postId = response.json('id');
        if (postId) {
          pollStatus(postId, headers, createStartedMs);
        }
      }
    } else {
      demo_post_create_failed.add(1, { endpoint: 'posts_create' });
    }
  }
}
