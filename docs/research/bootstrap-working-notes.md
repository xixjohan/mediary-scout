# Bootstrap Working Notes

This file is a temporary working record for bootstrap setup.

It is not the final bootstrap guide.
It only captures steps that have already been manually verified.

Bootstrap Step 1 assumes the repository runtime is available before credential checks:

1. create `.venv` if it does not exist
2. install repository dependencies
3. then obtain and validate credentials / base URLs below

---

## TMDB Read Token

Goal: obtain the value used for `TMDB_READ_TOKEN` in `.env`.

### What the user needs

- A TMDB account
- A signed-in browser session

### Steps

1. Sign in to TMDB.
2. Open [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).
3. When asked whether the API is for personal use, choose `Yes`.
4. In the personal-use confirmation dialog:
   - check the confirmation box
   - continue with the personal-use option
5. Complete the Developer Plan form.

### Recommended form values

- `Use Type`
  - Select `Personal`
- `Application Name`
  - Use any truthful personal project name
  - Example: `clawd-media-track (Personal)`
- `Application URL`
  - Use a real URL that represents the user or project
  - Preferred: GitHub profile URL
  - Also acceptable: repository URL for this project
- `Application Summary`
  - Example:
    `A personal-use tool for retrieving TMDB metadata to help organize and track movies and TV shows in a private media workflow.`
- `Contact Info`
  - Fill with real personal information

### Result

After submitting the form, TMDB returns to the API settings page.

On that page, copy:

- `API Read Access Token`

Use that value for:

- `TMDB_READ_TOKEN`

### Important Notes

- Do not use the short `API Key` value for this project.
- Use the long `API Read Access Token`.
- Users do not need a personal website just to complete this step.
- A GitHub profile URL or repository URL is sufficient, as long as it is real.

---

## 115 Cookie

Goal: obtain the value used for `PAN115_COOKIE` in `.env`.

### What the user needs

- A 115 account
- A browser that can install extensions

### Verified acquisition path

One verified path uses this browser extension:

- [115 Cookie Manager](https://chromewebstore.google.com/detail/115-cookie-manager/eommpjdhnkhahmekjplnkmnfbbjgpigp)

### Steps

1. Install the extension.
2. Open the extension.
3. Keep the default client type unless there is a reason to use a different one.
4. Scan the QR code with the 115 mobile app and complete login.
5. After login succeeds, copy the full cookie string shown by the extension.

### Required format

The value must be a full cookie string, not a single token.

Expected shape:

`UID=...; CID=...; SEID=...; KID=...`

At minimum, the verified working format includes:

- `UID`
- `CID`
- `SEID`
- `KID`

### Result

Use the copied full cookie string for:

- `PAN115_COOKIE`

### Important Notes

- A single token/hash is not enough for the current runtime contract.
- The runtime expects a full cookie string, not an intermediate token.
- After obtaining the cookie, either:
  - write it into `.env`, or
  - hand it to the agent so the agent can test connectivity and then write it into `.env`

---

## Pansou Base URL

Goal: obtain the value used for `PANSOU_BASE_URL` in `.env`.

### Verified implementation

The verified container/project in use is:

- [fish2018/pansou-web](https://github.com/fish2018/pansou-web)

This project packages the PanSou frontend and backend together and supports Docker deployment.

### Two supported paths

#### Path A: Use a public PanSou service

A verified public address currently exists:

- [https://so.252035.xyz/](https://so.252035.xyz/)

This means self-hosting is not strictly required for first-time bootstrap.

For users who want the fastest setup path, `PANSOU_BASE_URL` can point directly to that public URL.

#### Path B: Run a self-hosted PanSou container

Users who want more control can deploy their own `pansou-web` instance.

The upstream README provides a minimal Docker path:

```bash
docker run -d --name pansou -p 80:80 ghcr.io/fish2018/pansou-web
```

After deployment, use the reachable base URL of that instance for:

- `PANSOU_BASE_URL`

Example:

- `http://192.168.100.1:8888`

### Observed behavior

Both a self-hosted instance and the public service were verified as reachable.

Using the same keyword (`除恶`), both returned real results, but not identical result counts:

- self-hosted instance: `115=70`, `magnet=36`
- public service: `115=70`, `magnet=47`

This suggests:

- public service can be used for bootstrap and normal operation
- self-hosted and public instances may not return identical results
- users who need maximum control or consistency may still prefer self-hosting

### Important Notes

- `PANSOU_BASE_URL` is required by the current runtime contract.
- The repository example env can prefill the verified public service URL.
- Public service is acceptable for bootstrap and for users who do not want to self-host.
- Self-hosting is optional, not mandatory.
- Bootstrap should explicitly ask the human which path they want:
  - use the public service as-is
  - or provide a deployment environment for a self-hosted container
- If the public service becomes unavailable in the future, users should switch to a self-hosted deployment.
