/** A mistake in what the person asked for; API routes turn it into a 400. */
export class InputError extends Error {}

export function internalErrorResponse(): Response {
  return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}
