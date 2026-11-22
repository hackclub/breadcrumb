import { authorizationDetails } from "../../../lib/authorization";
export const GET = (request: Request) => authorizationDetails(request);

export const POST = (request: Request) => authorizationDetails(request);
