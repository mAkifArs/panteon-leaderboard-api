import http from 'k6/http'
import { check, sleep } from 'k6'
import { BASE_URL, randomUserId } from './_helpers.js'

export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '30s',
  thresholds: { http_req_failed: ['rate<0.001'] },
}

export default function () {
  if (Math.random() < 0.5) {
    const r = http.get(`${BASE_URL}/leaderboard/top?limit=100`)
    check(r, { 'top 200': (x) => x.status === 200 })
  } else {
    const r = http.get(`${BASE_URL}/leaderboard/current/${randomUserId()}`)
    check(r, { 'current ok': (x) => x.status === 200 || x.status === 404 })
  }
  sleep(0.05)
}
