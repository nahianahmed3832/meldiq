import { LiveKitSession } from "__WEB_MEDIA_MODULE__";
window.mediaState = { security: "verifying", flow: "none" };
window.joinMedia = async (media, key) => {
  const session = new LiveKitSession(
    new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) => {
            if (name === "security") window.mediaState.security = args[0];
            if (name === "flow") window.mediaState.flow = args[0];
          },
      },
    ),
  );
  const issues = await session.prepare(true);
  if (issues.microphone || issues.camera)
    throw Error("Browser test capture failed");
  await session.connect(media, key);
  window.mediaSession = session;
};
