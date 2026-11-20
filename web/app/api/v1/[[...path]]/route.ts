import { integrationsAPI } from "../../../../lib/integrations-api";
export const runtime = "nodejs";
export const maxDuration = 120;
const handler = (request: Request) => integrationsAPI(request);
export {
  handler as GET,
  handler as POST,
  handler as PATCH,
  handler as DELETE,
  handler as PUT,
  handler as HEAD,
  handler as OPTIONS,
};
