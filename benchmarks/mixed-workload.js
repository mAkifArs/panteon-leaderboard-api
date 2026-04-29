import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL, randomUserId, uniqueIdempotencyKey } from './_helpers.js'

export const options = {
  vus: Number(__ENV.VUS || 100),
  duration: __ENV.DURATION || '60s',
  thresholds: { http_req_failed: ['rate<0.001'] },
}

export default function () {
  const r = Math.random()
  if (r < 0.4) {
    const res = http.get(`${BASE_URL}/leaderboard/top?limit=100`)
    check(res, { 'top 200': (x) => x.status === 200 })
  } else if (r < 0.7) {
    const res = http.get(`${BASE_URL}/leaderboard/current/${randomUserId()}`)
    check(res, { 'current 200': (x) => x.status === 200 })
  } else {
    const body = JSON.stringify({
      userId: randomUserId(),
      amount: String(Math.floor(Math.random() * 1000) + 1),
    })
    const res = http.post(`${BASE_URL}/earnings`, body, {
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': uniqueIdempotencyKey(),
      },
    })
    check(res, { 'earn 201': (x) => x.status === 201 })
  }
}
