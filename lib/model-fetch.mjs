// Keep endpoint failures useful in both model discovery/tests and live replies.
export async function modelFetch(address, init, provider) {
  try { return await fetch(address, init); }
  catch (error) {
    if (init?.signal?.aborted) throw error;
    const endpoint = new URL(address);
    const code = error.cause?.code || error.cause?.errors?.[0]?.code;
    const reason = ({ECONNREFUSED: 'connection refused', ENOTFOUND: 'hostname not found', EAI_AGAIN: 'DNS unavailable', ETIMEDOUT: 'connection timed out', UND_ERR_CONNECT_TIMEOUT: 'connection timed out'})[code] || 'network connection failed';
    throw new Error(`Cannot reach model endpoint ${endpoint.origin}${endpoint.pathname} (${reason}). ${provider ? 'Check network access to your provider.' : 'Start the model server or restore its network connection.'} Retry when available, or change the address in Habitats → Add models.`, {cause: error});
  }
}
