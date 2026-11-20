import { authorizationDetails } from "../../../lib/authorization";
export const GET = (request: Request) => authorizationDetails(request);
