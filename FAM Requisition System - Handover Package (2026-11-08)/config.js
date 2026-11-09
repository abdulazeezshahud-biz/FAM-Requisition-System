/* Runtime deployment config — loaded before the app.
 *
 * In the Docker bundle (docker-compose.yml) this file is REGENERATED from the
 * PB_URL environment variable each time the web container starts, so you never
 * edit it by hand there.
 *
 * For a non-Docker deploy you may instead set the PocketBase URL here:
 *     window.PB_URL = "https://pb.yourdomain.com";
 *
 * Left blank, the app falls back to the default in index.html (standalone demo
 * on a public host; same-origin when served by PocketBase locally).
 */
