/** @template T @param {Response} response @returns {Promise<T>} */
export async function readJsonResponse(response) {
  const body = await response.text();
  try {
    return /** @type {T} */ (JSON.parse(body));
  } catch {
    const contentType = response.headers.get("content-type") || "unknown content type";
    throw new Error(`The server returned a non-JSON response (HTTP ${response.status}, ${contentType}). The request may have timed out at the gateway.`);
  }
}
