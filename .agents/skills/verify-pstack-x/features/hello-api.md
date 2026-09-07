# Hello API

`GET /api/hello` returns HTTP 200 with `{"message":"Hello from vinext"}`. POST returns 405. This route proves framework routing and supports process identity checks; it does not check database readiness. `/api/system/health` owns readiness.
