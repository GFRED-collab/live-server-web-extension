# kobalinesystems.com website

A static site (HTML and CSS, no build step) for the cPanel hosting at hostingireland.ie.

## Upload

1. cPanel → **File Manager** → open `public_html`.
2. Delete any placeholder `index.html` the host created. Keep `cgi-bin` and `.well-known`.
3. **Upload** `kobalinesystems-website.zip`, then right-click it → **Extract** into `public_html`.
   Then delete the zip.
   - The files must sit directly in `public_html` (`public_html/index.html`), not in a sub-folder.
4. Turn on **Settings → Show Hidden Files** in File Manager to see `.htaccess`.

In Cloudflare, set **SSL/TLS → Full** and turn on **SSL/TLS → Edge Certificates → Always Use
HTTPS**. The `.htaccess` deliberately has no HTTPS redirect, so the two can't loop.

## Files

- `index.html`: the page, with sections for Services, Solutions, How we work, About and Contact
- `styles.css`: all the styling. The brand colours are at the top.
- `favicon.svg`: the K mark, also used in the header
- `404.html`: the page shown for missing addresses
- `.htaccess`: Apache settings (error page, security headers, caching)
- `robots.txt`: lets search engines index the site

To make a new zip after editing, run this from inside this folder:

```bash
zip -r kobalinesystems-website.zip index.html styles.css favicon.svg 404.html .htaccess robots.txt
```
