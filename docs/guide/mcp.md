# Máy chủ MCP của DuckOJ

`apps/mcp` là một máy chủ **Model Context Protocol** (MCP): nó cho một trợ lý
AI — Claude Code, Claude Desktop, hoặc bất kỳ máy khách MCP nào — đọc đề bài,
nộp bài và theo dõi kết quả chấm trên DuckOJ, bằng chính **mã truy cập** của
bạn.

> **Nguyên tắc quan trọng nhất:** mặc định máy chủ chỉ có **công cụ đọc**. Các
> công cụ ghi (nộp bài, hỏi ban tổ chức, sửa đề) chỉ xuất hiện khi bạn bật
> `DUCKOJ_MCP_WRITES=1`. Không có công cụ quản trị nào, và cũng không có công
> tắc nào bật chúng lên.

## 1. Chuẩn bị

```bash
corepack pnpm install
corepack pnpm --filter @duckoj/mcp build
```

Sau bước này tệp cần chạy nằm ở `apps/mcp/dist/main.js`.

## 2. Tạo mã truy cập và chọn phạm vi

Vào **Mã truy cập** (`/tokens`) trên web, bấm tạo mã mới, rồi tick đúng những
phạm vi bạn cần. Mã chỉ hiện **một lần** — chép ngay.

| Bạn muốn làm gì | Phạm vi cần tick |
| --- | --- |
| Đọc đề, thống kê, lời giải | `problems:read` |
| Xem danh sách ngôn ngữ (`duckoj://languages`) | `languages:read` |
| Xem bài nộp, chờ kết quả chấm | `submissions:read` |
| **Nộp bài** | `submissions:write` |
| Xem kỳ thi, bảng điểm, thông báo | `contests:read` |
| **Hỏi ban tổ chức / ra thông báo** | `contests:write` |
| Xem tiến độ của chính mình | `users:read` |
| **Sửa đề, tag, độ khó, lời giải** | `problems:write` |
| **Tạo bản nháp gói bài và build** | `problems:publish` |

Tick càng ít càng tốt: mã truy cập **thu hẹp** quyền của bạn chứ không bao giờ
mở rộng nó (D50), nên một mã chỉ có `problems:read` là một mã không thể nộp bài
dù trợ lý có muốn.

Bạn cũng có thể dùng luôn mã đã lưu bởi `oj login` — xem mục 4.

## 3. Cấu hình máy khách

### Claude Code

Tạo `.mcp.json` ở thư mục dự án (hoặc thêm vào `~/.claude.json`):

```json
{
  "mcpServers": {
    "duckoj": {
      "command": "node",
      "args": ["/duong/dan/den/duckoj/apps/mcp/dist/main.js"],
      "env": {
        "DUCKOJ_URL": "http://localhost:8080",
        "DUCKOJ_TOKEN": "dán-mã-truy-cập-vào-đây"
      }
    }
  }
}
```

Hoặc một dòng lệnh:

```bash
claude mcp add duckoj \
  --env DUCKOJ_URL=http://localhost:8080 \
  --env DUCKOJ_TOKEN=... \
  -- node /duong/dan/den/duckoj/apps/mcp/dist/main.js
```

### Claude Desktop

Sửa `claude_desktop_config.json` (Linux: `~/.config/Claude/`, macOS:
`~/Library/Application Support/Claude/`) rồi khởi động lại ứng dụng:

```json
{
  "mcpServers": {
    "duckoj": {
      "command": "node",
      "args": ["/duong/dan/den/duckoj/apps/mcp/dist/main.js"],
      "env": {
        "DUCKOJ_URL": "https://oj.truong-ban.vn",
        "DUCKOJ_TOKEN": "dán-mã-truy-cập-vào-đây"
      }
    }
  }
}
```

`DUCKOJ_URL` nhận địa chỉ trần (`http://localhost:8080`); máy chủ tự thêm
`/api/v1`. Nếu bạn ghi sẵn đường dẫn thì nó dùng nguyên như bạn ghi.

### Chạy tay để thử

```bash
corepack pnpm --silent --filter @duckoj/mcp start
```

`--silent` là **bắt buộc**: pnpm in dòng tiêu đề script ra `stdout`, mà `stdout`
là nơi giao thức MCP truyền dữ liệu — thiếu nó, máy khách không bắt tay được.

## 4. `oj mcp` — dùng lại mã đã đăng nhập

Nếu bạn đã chạy `oj login`, không cần khai báo mã lần thứ hai:

```bash
oj login --url http://localhost:8080/api/v1 --token ...
oj mcp
```

`oj mcp` đọc `~/.config/duckoj/config.json` rồi khởi động chính máy chủ này.
Trong tệp cấu hình của Claude, dùng:

```json
{ "mcpServers": { "duckoj": { "command": "oj", "args": ["mcp"] } } }
```

## 5. Công tắc ghi

```bash
DUCKOJ_MCP_WRITES=1 node /duong/dan/den/duckoj/apps/mcp/dist/main.js
```

- **Không đặt biến này** → 12 công cụ, tất cả đều chỉ đọc.
- **`DUCKOJ_MCP_WRITES=1`** → thêm 7 công cụ ghi: `submissions_submit`,
  `contests_ask`, `contests_announce`, `problems_patch`,
  `problems_draft_create`, `problems_draft_put_file`, `problems_draft_build`.

Chỉ giá trị `1` mới bật. `true`, `yes`, `0` hay ô trống đều **tắt**.

Khi tắt, các công cụ ghi **không tồn tại** với máy khách — chúng không nằm
trong danh sách công cụ, chứ không phải bị từ chối lúc gọi.

## 6. Có những gì

**Công cụ đọc.** `problems_search`, `problems_get`, `problems_stats`,
`problems_editorial`, `submissions_list`, `submissions_get`,
`submissions_watch`, `contests_list`, `contests_get`, `contests_scoreboard`,
`contests_clarifications`, `me_progress`.

**Tài nguyên.** `duckoj://problems/{code}/statement`,
`duckoj://contests/{key}/scoreboard`, `duckoj://tags`, `duckoj://languages`.

**Lời nhắc (prompts).** `solve-problem` (đề + giới hạn + ví dụ, đóng gói sẵn
cho trợ lý) và `prepare-problem` (quy trình soạn gói bài).

Mỗi công cụ trả về **một dòng tóm tắt** rồi tới **JSON gọn**. Khi lỗi, JSON có
`code` và `detail` của API; riêng lúc bị chặn tốc độ nộp bài (D80) có thêm
`retryAfterSeconds` — số giây phải chờ.

## 7. Khi có trục trặc

| Hiện tượng | Nguyên nhân thường gặp |
| --- | --- |
| `no DuckOJ credential` | Thiếu `DUCKOJ_URL`/`DUCKOJ_TOKEN` và chưa `oj login`. |
| Máy khách báo không bắt tay được | Thiếu `--silent` khi chạy qua pnpm, hoặc chưa `build`. |
| `unauthorized` ở mọi công cụ | Mã hết hạn hoặc đã bị thu hồi — tạo mã mới. |
| Một công cụ trả `403` | Mã thiếu phạm vi ghi trong mô tả của công cụ đó. |
| Không thấy `submissions_submit` | Chưa đặt `DUCKOJ_MCP_WRITES=1`. |
| `submission_rate_limited` | Đúng thiết kế (D80). Chờ đủ `retryAfterSeconds` giây. |
| `samples.source` là `none` | Đề không có bảng ví dụ theo mẫu — đọc thẳng phần đề. |

## English

`apps/mcp` is a **Model Context Protocol** server: it lets an AI assistant —
Claude Code, Claude Desktop, or any MCP client — read problems, submit
solutions and watch verdicts on DuckOJ, using your own **access token**.

> **The rule that matters most:** by default the server exposes **read tools
> only**. Write tools (submitting, asking clarifications, editing problems)
> appear only when you set `DUCKOJ_MCP_WRITES=1`. There are no admin tools,
> and no switch that turns any on.

### 1. Build it

```bash
corepack pnpm install
corepack pnpm --filter @duckoj/mcp build
```

The entry point is then `apps/mcp/dist/main.js`.

### 2. Mint a token, and pick its scopes

Go to **API tokens** (`/tokens`), mint a new one and tick only the scopes you
need. The token is shown **once**.

| What you want to do | Scope to tick |
| --- | --- |
| Read statements, statistics, editorials | `problems:read` |
| Read the language list (`duckoj://languages`) | `languages:read` |
| Read submissions, wait for a verdict | `submissions:read` |
| **Submit** | `submissions:write` |
| Read contests, scoreboards, clarifications | `contests:read` |
| **Ask a clarification / announce** | `contests:write` |
| Read your own progress | `users:read` |
| **Edit statements, tags, difficulty, editorials** | `problems:write` |
| **Open package drafts and build them** | `problems:publish` |

Tick as few as possible: a token **narrows** your authority and never grants
anything (D50), so a `problems:read`-only token cannot submit however much an
agent would like to.

### 3. Configure the client

**Claude Code** — `.mcp.json` in the project (or an entry in `~/.claude.json`):

```json
{
  "mcpServers": {
    "duckoj": {
      "command": "node",
      "args": ["/path/to/duckoj/apps/mcp/dist/main.js"],
      "env": {
        "DUCKOJ_URL": "http://localhost:8080",
        "DUCKOJ_TOKEN": "paste-the-token-here"
      }
    }
  }
}
```

or, in one line:

```bash
claude mcp add duckoj \
  --env DUCKOJ_URL=http://localhost:8080 \
  --env DUCKOJ_TOKEN=... \
  -- node /path/to/duckoj/apps/mcp/dist/main.js
```

**Claude Desktop** — the same block in `claude_desktop_config.json` (Linux:
`~/.config/Claude/`, macOS: `~/Library/Application Support/Claude/`), then
restart the app.

`DUCKOJ_URL` takes a bare origin (`http://localhost:8080`) and the server
appends `/api/v1`; a URL that already names a path is used exactly as given.

To run it by hand:

```bash
corepack pnpm --silent --filter @duckoj/mcp start
```

`--silent` is **load-bearing**: pnpm prints its script banner on `stdout`, and
`stdout` is the MCP wire — without it the client cannot complete the
handshake.

### 4. `oj mcp` — reuse the CLI's token

If you have run `oj login` there is no second credential to manage:

```bash
oj login --url http://localhost:8080/api/v1 --token ...
oj mcp
```

`oj mcp` reads `~/.config/duckoj/config.json` and starts this same server, so
a client config can be as short as
`{ "command": "oj", "args": ["mcp"] }`.

### 5. The writes switch

```bash
DUCKOJ_MCP_WRITES=1 node /path/to/duckoj/apps/mcp/dist/main.js
```

- **unset** → 12 tools, every one read-only.
- **`DUCKOJ_MCP_WRITES=1`** → 7 more: `submissions_submit`, `contests_ask`,
  `contests_announce`, `problems_patch`, `problems_draft_create`,
  `problems_draft_put_file`, `problems_draft_build`.

Only the exact value `1` enables them; `true`, `yes`, `0` and an empty value
are all off. While off, the write tools do not exist as far as the client is
concerned — they are absent from the tool list, not refused at call time.

### 6. What is exposed

**Resources.** `duckoj://problems/{code}/statement`,
`duckoj://contests/{key}/scoreboard`, `duckoj://tags`, `duckoj://languages`.

**Prompts.** `solve-problem` (statement, limits and samples packaged for an
agent) and `prepare-problem` (the package-authoring pipeline).

Every tool answers one summary line followed by compact JSON. Failures carry
the API's `code` and `detail`; a submission refused by D80's meter also
carries `retryAfterSeconds`.

### 7. When something is wrong

| Symptom | Usual cause |
| --- | --- |
| `no DuckOJ credential` | No `DUCKOJ_URL`/`DUCKOJ_TOKEN` and no `oj login`. |
| The client cannot handshake | Missing `--silent` under pnpm, or not built. |
| Everything answers `unauthorized` | The token expired or was revoked. |
| One tool answers `403` | The token lacks the scope named in that tool's description. |
| `submissions_submit` is missing | `DUCKOJ_MCP_WRITES` is not `1`. |
| `submission_rate_limited` | Working as designed (D80) — wait `retryAfterSeconds`. |
| `samples.source` is `none` | The statement has no sample table in the known shape; read the statement. |
