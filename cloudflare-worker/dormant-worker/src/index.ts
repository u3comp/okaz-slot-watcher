export function dormantResponse(request: Request): Response {
  if (request.method === "POST") return new Response(null, { status: 200 });
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

export default {
  async fetch(request: Request): Promise<Response> {
    return dormantResponse(request);
  },
};
