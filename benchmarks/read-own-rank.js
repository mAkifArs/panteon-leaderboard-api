import http from 'k6/http'
import { check } from 'k6'
import { BASE_URL, randomUserId } from './_helpers.js'

export const options = {
  vus: Number(__ENV.VUS || 100),
  duration: __ENV.DURATION || '60s',
  thresholds: { http_req_failed: ['rate<0.001'] },
}

export default function () {
  const r = http.get(`${BASE_URL}/leaderboard/current/${randomUserId()}`)
  check(r, { 'status 200': (x) => x.status === 200 })
}
