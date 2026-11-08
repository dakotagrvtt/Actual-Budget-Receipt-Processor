// A client that is made again whenever the settings it is made from change (nextcloud.js: address, user, app password).
/** Returns get(...parts): the client made by make(...parts), reused while the parts stay the same. */
export function keyedClient(make) {
  let made = null;
  return (...parts) => {
    const sig = JSON.stringify(parts);
    if (made?.sig !== sig) made = { sig, client: make(...parts) };
    return made.client;
  };
}
