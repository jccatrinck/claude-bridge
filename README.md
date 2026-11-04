# claude-bridge

A local MCP server and a Chrome extension (MV3). Together they let Claude Code and Claude Desktop drive your own Chrome profiles over the Chrome DevTools Protocol.

- **No upload size cap.** `upload` gives Chrome local file paths (`DOM.setFileInputFiles`), and Chrome reads the files from disk. A 50 MB video works the same as a 5 KB text file.
- **Named profiles.** Each Chrome profile you install it in gets a name, such as `personal` or `work`. Every tool takes `profile`, and nothing guesses which profile you meant.
- **Localhost only.** The server listens on `127.0.0.1` and needs a pairing token. The extension has no remote code and only talks to that local server.

```
Claude Code / Claude Desktop ──stdio(MCP)──► server/index.mjs ──ws://127.0.0.1:47811──► extension in each Chrome profile
                                              (first one = hub, later ones relay through it)
```

## Install

Requires Node ≥ 22 and Chrome ≥ 120.

```sh
git clone https://github.com/jccatrinck/claude-bridge.git
cd claude-bridge
npm install
```

### 1. Register the MCP server

**Claude Code:**

```sh
claude mcp add claude-bridge -- node /absolute/path/to/claude-bridge/server/index.mjs
```

Use the absolute path to your clone.

Add `-s user` to make it available in every project.

**Claude Desktop:** in `%APPDATA%\Claude\claude_desktop_config.json`, add:

```json
{
  "mcpServers": {
    "claude-bridge": {
      "command": "node",
      "args": ["C:\\path\\to\\claude-bridge\\server\\index.mjs"]
    }
  }
}
```

Then restart Claude Desktop. You can run both clients at once. The first process to start becomes the hub, and the other relays through it. If the hub exits, another process takes over within a second or two, and the extensions reconnect on their own.

The first time the server runs, it writes the pairing token to `%APPDATA%\claude-bridge\token`. On macOS that's `~/Library/Application Support/claude-bridge/token`, and on Linux `~/.config/claude-bridge/token`.

### 2. Load the extension in each Chrome profile

In every profile you want Claude to drive:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder of your clone.
3. Open the extension's **Details** page and turn on **Allow access to file URLs**. Without it, Chrome may refuse uploads with "Not allowed".
4. The options page opens. If it doesn't, click the toolbar icon. Set:
   - **Profile name**, for example `personal`. Each profile needs a different name.
   - **Pairing token**: the contents of the token file.
   - Optionally, **Upload roots** and **Blocked sites** (see Settings below).
5. Click **Save**. The status at the top should turn **connected**. A badge on the toolbar icon means it isn't connected (`?` setup needed, `!` refused, `×` hub not reachable).

The manifest pins the extension id (`obflamjmnjpkmgmgfckggckdobjpalck`) with a public key. That makes the id the same in every profile and on every machine. The hub accepts browser connections only from that origin.

If Claude in Chrome is installed in the same profile, disable it there: only one debugger can attach to a tab.

## Using profiles

- `list_profiles` shows each connected profile's name, id, extension version and tab count.
- With **one** profile connected, `profile` is optional.
- With **several** connected, a call without `profile` fails, and the error lists the names, for example: `Several profiles are connected; pass "profile" with one of: personal, work.`
- An unknown name fails the same way. The bridge never picks a profile for you.

## Tools

| Tool | What it does |
|---|---|
| `list_profiles` | Lists the connected profiles. |
| `tabs_list` | Lists tabs in the **Claude** tab group, or every tab with `all: true`. |
| `tab_open` | Opens a tab in the **Claude** tab group, in the background unless `active: true`, waits for load, and returns `tabId`. |
| `tab_close` | Closes a tab. |
| `navigate` | Goes to a URL, or `back`, `forward` or `reload`, and waits for the load event (30 s). |
| `screenshot` | Returns a JPEG of the viewport, a `region`, or the full page (`fullPage`). Takes `scale` and `quality`. |
| `snapshot` | Returns the accessibility tree as text, with refs such as `e12` (`interactiveOnly`, `maxChars`). |
| `find` | Finds elements whose name, role, value or text contains a string, and returns refs. |
| `click` | Clicks a ref (scrolled into view, clicked at its center) or an `x,y` point. Takes `button`, `clickCount` and `modifiers`. |
| `type` | Inserts text at the focus, focusing `ref` first if one is given. |
| `key` | Presses key chords such as `Enter`, `shift+Enter`, `ctrl+a Backspace`, or `ArrowDown ArrowDown Enter`. Takes `repeat`. |
| `scroll` | Scrolls with the mouse wheel by `dx`/`dy` at `x,y`, or scrolls a ref into view. |
| `fill` | Sets the value of an input, textarea, select (by value or label), checkbox, radio or contenteditable element, and fires `input` and `change`. |
| `upload` | Puts local files into a file input. See below. |
| `eval` | Runs JavaScript in the page. Promises are awaited and the value is returned. |
| `console` | Returns console messages and uncaught errors buffered since the bridge attached to the tab (`pattern`, `clear`, `limit`). |
| `network` | Returns requests buffered since the bridge attached to the tab (`pattern`, `clear`, `limit`). |
| `wait` | Sleeps for up to 10 s. |
| `dialog` | Answers a JavaScript alert, confirm or prompt (`accept`, `text`). |

Refs belong to one tab. They stay valid until that tab navigates. After a navigation, take a new `snapshot` or use `find`.

**Uploads.** `upload(tabId, paths, ref | selector)`:

- If the ref or selector is an `<input type=file>`, the files are set on it directly.
- If it's a button that opens a file chooser, including one that creates its input only when clicked, the bridge clicks the button and answers the chooser.
- With neither, the bridge arms itself, and the next file chooser the tab opens receives the files.

Before anything reaches Chrome, the MCP server checks every path. Each one must exist, be a readable regular file, and resolve inside an **upload root**, with symlinks resolved. The result lists each file's name and size, along with the sizes the page reports.

**Dialogs never block.** If an action opens an alert, confirm or prompt, the tool returns right away with `dialogOpened`. Until you answer it with `dialog`, other tools on that tab refuse to run and say why.

While the bridge is attached to a tab, Chrome shows *"claude-bridge started debugging this browser"*. The bridge detaches when the tab closes, or after 5 minutes idle. If you click **Cancel** on that bar, the bridge detaches, and the next tool call re-attaches.

## Settings

Settings are per profile, on the extension options page, stored in `chrome.storage.local`.

| Setting | Default | Notes |
|---|---|---|
| Profile name | (required) | The extension doesn't connect until a name is set. Use letters, digits, `.`, `_` and `-`. |
| Pairing token | (required) | The contents of the token file. |
| Hub port | `47811` | If you change it, set `CLAUDE_BRIDGE_PORT` for the server to the same value. |
| Blocked sites | (none) | One pattern per line. The tool router refuses to act on matching pages. `bank.com` matches that host and its subdomains, `*.corp.example` matches subdomains only, and `https://mail.example.com/secret/*` is matched as a glob against the URL. |
| Upload roots | your home folder | The folders `upload` may read from. The MCP server enforces this. |

**Export** and **Import** save and load the settings as JSON, which makes setting up another profile quick. The exported file contains the pairing token.

Server environment variables (all optional):

| Variable | Meaning |
|---|---|
| `CLAUDE_BRIDGE_PORT` | Hub port (default `47811`). |
| `CLAUDE_BRIDGE_DIR` | Folder for the token file (default `%APPDATA%\claude-bridge`). |
| `CLAUDE_BRIDGE_EXTENSION_IDS` | Extra extension ids allowed to connect, comma-separated, for example a future Web Store id. |

## Security

**Read this:** the extension gives the local MCP server **full control of every Chrome profile it's installed in**. Through the DevTools Protocol it can read any page, run JavaScript (`eval`), click and type with your sign-ins, and upload files from your upload roots. Install it only in profiles you want Claude to drive. Use **Blocked sites** for sites such as banking.

- The hub listens on `127.0.0.1` only. Every socket must present the pairing token. Browser connections must also come from the pinned `chrome-extension://` origin, which stops ordinary web pages from connecting. Other bridge processes connect without an `Origin` header and still need the token.
- `upload` reads only inside the upload roots, after resolving symlinks and junctions, so a link can't lead outside them.
- The extension loads no remote code and opens no network connection except to the hub.
- Blocked sites are checked for the tab's current URL and for every navigation target.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No Chrome profiles are connected` | Open the extension options in that profile. Check that the profile name and token are set and the status says **connected**. |
| Status `refused: bad pairing token` | Paste the token again from the token file. If you deleted the file, a new token was generated. |
| Status `refused: profile name … already used` | Two Chrome profiles have the same name. Rename one of them. |
| Status stays `offline` | No MCP server is running. Start Claude Code or Claude Desktop, or run `npm start`. Also check that the hub port matches. |
| `upload` fails with `Not allowed` | Turn on **Allow access to file URLs** on the extension's Details page. |
| `… is outside the upload roots` | Add the file's folder under **Upload roots**. |
| `Chrome does not let extensions debug this page` | `chrome://` pages, the Web Store and other extensions' pages can't be automated. Navigate to a normal page first. |
| `Cannot attach … another debugger` | Close DevTools on that tab, or disable the other debugging extension, such as the Web Store Claude extension. |
| `Unknown ref "e12"` | The page navigated since the snapshot. Take a new `snapshot`. |

The server logs to stderr with the prefix `[claude-bridge]`. In Claude Code, `claude --debug` shows MCP stderr.

## Development

```
extension/   manifest.json, background.js (socket, debugger, tool router), options.html/.js, lib/ (pure helpers), icons/
server/      index.mjs (MCP stdio), hub.mjs (hub/relay election, routing), protocol.mjs, upload.mjs, tools.mjs, config.mjs
test/        node:test suites, fixtures/upload.html + serve.mjs, e2e.mjs
```

- `npm test` runs the unit and integration tests: protocol validation, routing between two fake extensions, missing and ambiguous profiles, hub takeover, bad token and bad origin, upload path checks including symlinks, snapshot refs against a mocked AX tree, and two MCP clients over stdio sharing one hub.
- `npm run fixture` serves `test/fixtures/upload.html` at `http://127.0.0.1:47900/` and writes a 50 MB test file into the temp folder, for manual checks.
- `CHROME=<path to Chrome for Testing> npm run e2e` runs a full check against a real browser with the extension loaded, in a throwaway profile. The steps are: open, snapshot, find, click, type, keys, fill, a 50 MB upload by input and by chooser, screenshot, dialogs, scroll, console, network, navigate, a blocked site, and closing the tab. Branded Chrome ignores `--load-extension`, so get Chrome for Testing with `npx @puppeteer/browsers install chrome@stable`.

Not in v1: GIF recording, shortcuts, and in-page panels. Snapshots cover the main frame only; iframe content isn't included.

## License

MIT
