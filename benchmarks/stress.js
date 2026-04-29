// Concurrency stress test. Ramps virtual users up to 1000 to probe
// how a single API instance behaves under bursty load — the closest
// local proxy for the brief's "2M concurrent users" framing, since
// no laptop can actually generate 400k RPS.
import http from 'k6/http'
import { BASE_URL, randomUserId, uniqueIdempotencyKey } from './_helpers.js'

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '60s', target: 500 },
    { duration: '60s', target: 1000 },
    { duration: '30s', target: 0 },
  ],
  thresholds: { http_req_failed: ['rate<0.01'] },
}

export default function () {
  const r = Math.random()
  if (r < 0.4) {
    http.get(`${BASE_URL}/leaderboard/top?limit=100`)
  } else if (r < 0.7) {
    http.get(`${BASE_URL}/leaderboard/current/${randomUserId()}`)
  } else {
    http.post(
      `${BASE_URL}/earnings`,
      JSON.stringify({
        userId: randomUserId(),
        amount: String(Math.floor(Math.random() * 1000) + 1),
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': uniqueIdempotencyKey(),
        },
      },
    )
  }
}
