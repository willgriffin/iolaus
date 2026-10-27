import {
  assistantCorsHeaders,
  assistantErrorResponse,
  openPublicProfileVoice,
} from '$lib/server/public-profile-assistant';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({
  params,
  request,
  getClientAddress,
}) => {
  try {
    return await openPublicProfileVoice(
      params.handle,
      request,
      getClientAddress(),
    );
  } catch (error) {
    return assistantErrorResponse(error, safeCors(request));
  }
};
export const OPTIONS: RequestHandler = ({ request }) => {
  try {
    return new Response(null, {
      status: 204,
      headers: assistantCorsHeaders(request),
    });
  } catch (error) {
    return assistantErrorResponse(error);
  }
};
function safeCors(request: Request) {
  try {
    return assistantCorsHeaders(request);
  } catch {
    return {};
  }
}
