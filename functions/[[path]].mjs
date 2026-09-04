export async function onRequest(context) {
  return context.env.APP.fetch(context.request);
}
