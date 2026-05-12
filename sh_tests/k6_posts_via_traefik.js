import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: __ENV.VUS ? Number(__ENV.VUS) : 10,
  duration: __ENV.DURATION || '30s',
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:8080';
const token = __ENV.TOKEN || '';

export default function () {
  const payload = JSON.stringify({ text: `k6 post ${__VU}-${__ITER}-${Date.now()}` });
  const res = http.post(`${baseUrl}/posts`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  check(res, {
    'status is accepted/ok': (r) => r.status === 202 || r.status === 200,
  });

  sleep(0.2);
}
