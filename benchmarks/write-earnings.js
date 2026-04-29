import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL, randomUserId, uniqueIdempotencyKey } from './_helpers.js'

export const options = {
  vus: Number(__ENV.VUS || 100),
  duration: __ENV.DURATION || '60s',
  thresholds: { http_req_failed: ['rate<0.001'] },
}

export default function () {
  const body = JSON.stringify({
    userId: randomUserId(),
    amount: String(Math.floor(Math.random() * 1000) + 1),
  })
  const r = http.post(`${BASE_URL}/earnings`, body, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': uniqueIdempotencyKey(),
    },
  })
  check(r, { 'status 201': (x) => x.status === 201 })
}
