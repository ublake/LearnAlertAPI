const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store"
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders
    }
  });
}

export function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: BASE_HEADERS
  });
}

export function apiError(code, message, status = 400, requestId = null, details = null) {
  return json(
    {
      success: false,
      requestId,
      error: {
        code,
        message,
        ...(details ? { details } : {})
      }
    },
    status
  );
}
