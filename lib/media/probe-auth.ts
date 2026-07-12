type ConnectivityResult = {
  success: boolean;
  message: string;
};

interface ProbeAuthOptions {
  providerName: string;
  request: () => Promise<Response>;
}

export async function probeAuth({
  providerName,
  request,
}: ProbeAuthOptions): Promise<ConnectivityResult> {
  try {
    const response = await request();
    if (response.status === 401 || response.status === 403) {
      const text = await response.text();
      return {
        success: false,
        message: `${providerName} auth failed (${response.status}): ${text}`,
      };
    }
    return { success: true, message: `Connected to ${providerName}` };
  } catch (err) {
    return { success: false, message: `${providerName} connectivity error: ${err}` };
  }
}
