# 部署到云服务器（VPS）

> 面向「自己的云服务器 / VPS」这套环境。容器平台（Fly / Railway / ECS）也适用本文，
> 只是把 systemd 那节换成容器里的进程管理。
>
> **Serverless（Vercel / Netlify）不适用** —— 原因见 §10.3 与 §16（2026-11-20 复核过
> Vercel 最新规则，结论不变，且理由比当初更强）。
>
> **但可以拆开部署**：页面托管在 Vercel、实时服务留在自己的服务器 —— 见 §17。

---

## 0. 先搞清楚这个项目在云上是什么

它不是静态站点，是**一个 Node 进程**：

- 一个 HTTP 端口（默认 3000）同时承载两件事：Next.js 页面 + WebSocket（路径 `/ws`）；
- 房间状态在**进程内存**里，落盘到 `.data/rooms.json` + `.data/sessions.json`（为了「重启不丢」）；
- 人机对弈的 AI 是**服务端起 Stockfish 子进程**算的。

所以部署的形态就是：跑一个长驻 Node 进程，前面挂个反代。

---

## 1. 服务器准备

```bash
# Node ≥ 18.17（Next 14 的下限），推荐 20 / 22 LTS
node -v

# 建一个专用用户，别用 root
sudo adduser --system --group --home /opt/lan-chess lan-chess

# 把项目放进去（git clone 或 scp 都行）
sudo git clone <仓库地址> /opt/lan-chess
sudo chown -R lan-chess:lan-chess /opt/lan-chess
cd /opt/lan-chess
```

**为什么不能图省事用 root**：房间状态要往 `.data/` 落盘。root 跑出来的文件属主是 root，
以后换成普通用户就写不进去了 —— 这个坑在部署自检里专门有第 4 项在盯。

## 2. 安装依赖 + 构建

> ❌ **禁止在这台共享生产机上做并发压测 / 压力测试。**
>
> ⚠️ **2026-11-27 这台机器又僵死了一次**（特征与 11-23 完全一致，死因归类与取证清单见 **§18**）。
> 所以这条禁令不是「理论上有风险」，是**已经交过两次学费**。
>
> 这不是「小心点就行」的那种禁令，是**做不到**：
>
> - 2026-11-23 实测：在本机发起 500 条并发 WebSocket 连接，**整机僵死** ——
>   nginx 和 sshd 全部无响应（内核还在应答 TCP 握手，但用户态拿不到 CPU），
>   同时跑的另外几个 node 服务和 docker 被 **OOM killer 直接干掉**。
>   恢复手段只有**从云控制台重启**，agent 做不到。
> - 僵死时的外部特征（用来判断「是它挂了」还是「网络断了」）：
>   - `ping` 通、网络正常；
>   - `nc -z` 探 22/80/443 **TCP 握手成功**，但 HTTP 无响应、SSH 卡在 banner 阶段；
>   - 不是 80/443 的其他端口（node 服务、docker）**连 TCP 都握不上** —— 那些进程被杀了。
>
> **要测容量，去别处测**：本地机器、或者一台一次性的小机器。
>
> 🚫 **2026-11-27 球球拍板：这条路彻底关闭 —— 本项目不做任何压测 / 容量测试。**
> 理由：这是个家用小项目，真实用户就那么几个，压测出来的数字没有意义，
> 而代价是**把这台还跑着 4 个线上站点的机器打死**（已经发生过两次）。
> 所以本仓库里**不再保留任何压测脚本**，也**不要再写**。
>
> （11-23 那次实测的数据留在 §17.11，只当历史记录，不再复现。）
>
> ⚠️ 而且**算稳态内存是不够的**：500 条连接稳态大约只吃 250MB（可用内存还有 534MB），
> 但**连接风暴的峰值**是另一回事 —— 500 次 TLS 握手 + 双跳 socket 缓冲同时发生，
> 4GB swap 一旦打满就是死亡螺旋。

> ⚠️ **先确认这台机器是「专用的」，再决定要不要在这构建。**
>
> `next build` 的内存峰值**远高于**装依赖（实测：装依赖峰值 1257MB，而构建能把一台
> 总内存 1586MB 的机器打到**整机僵死**）。如果这台机器上**还跑着别的线上服务**，
> 构建会把它们一起拖下水 —— 而且**一旦僵死你连不上 SSH**（TCP 能连上但 banner 出不来，
> sshd 抢不到 CPU），唯一的救命手段是**从云控制台重启**，agent 做不到。
>
> **共享的生产机上，正确姿势是「在别处构建，把产物传上来跑」**：
>
> ```bash
> # 本地（或任意大内存机器）
> npm ci && npm run build
> tar -czf /tmp/lan-chess-build.tar.gz .next node_modules package.json server.ts next.config.mjs
> scp /tmp/lan-chess-build.tar.gz server:/tmp/
>
> # 服务器上只解压 + 跑，不构建
> tar -xzf /tmp/lan-chess-build.tar.gz -C /opt/lan-chess
> ```
>
> 真要在服务器上构建，先 `free -m` 看余量，**并确认没有别的服务在跑**。

### 2.1 「在别处装依赖再传上来」的坑：**原生二进制是平台相关的**

2026-11-23 实测踩到：在 Mac 上 `npm ci --omit=dev` 再把 `node_modules` 传到 Linux 服务器，
**服务起不来** —— esbuild 的二进制是按平台分的。

```
esbuild/lib/main.js: generateBinPath ...
  → 找不到可执行的二进制
```

原因：`node_modules/@esbuild/` 下面是**按平台命名**的目录，
macOS 上装出来的是 `@esbuild/darwin-arm64`，Linux 服务器要的是 `@esbuild/linux-x64`。
`npm rebuild esbuild` **不会**换平台包（它只重跑安装脚本，平台包还在原地）。

修法（在服务器上执行）：

```bash
cd /opt/lan-chess
# 版本号要对上：node -p "require('./node_modules/esbuild/package.json').version"
sudo -u lan-chess npm install --no-save --no-package-lock @esbuild/linux-x64@<版本>
rm -rf node_modules/@esbuild/darwin-arm64   # 留着也没用，还占地方
```

**要留心的包**：凡是带 `@<平台>-<架构>` 目录的都属于这一类（esbuild、@next/swc-* 等）。
**只跑 WS 的服务**只需要 esbuild 这一个；`@next/swc-*` 跟它无关。

> 传输时 macOS 的 xattr 会让 tar 刷一堆
> `Ignoring unknown extended header keyword 'LIBARCHIVE.xattr.com.apple.provenance'`
> —— **无害**，忽略即可。


```bash
cd /opt/lan-chess
npm ci                 # 按 lockfile 精确安装
npm run build          # next build
```

> **构建要带 devDependencies**。`next build` 需要 `typescript` 和 `@types/*`，它们在
> devDependencies 里；用 `npm ci --omit=dev` 装出来的环境**构建会失败**。
>
> 想让服务器上的依赖精简一点的话，**构建完成之后**再裁：
> ```bash
> npm prune --omit=dev   # tsx 在 dependencies 里，不受影响；但下次重建得先 npm ci
> ```

## 3. 交给 systemd 管

```bash
sudo cp deploy/lan-chess.service /etc/systemd/system/
sudo nano /etc/systemd/system/lan-chess.service   # 改「改这里」的三处
sudo systemctl daemon-reload
sudo systemctl enable --now lan-chess
sudo systemctl status lan-chess
journalctl -u lan-chess -f                          # 看日志
```

单元文件里要改的：`User`/`Group`、`WorkingDirectory`（项目路径）、`ExecStart` 里的 node 绝对路径
（`which node` 查）。反代在前面挡着，所以 3000 端口只监听本机就够 —— 但服务本身默认监听
`0.0.0.0`，靠防火墙挡住外部访问（见下）。

手动跑（不装 systemd）的话：`npm start`（= `NODE_ENV=production tsx server.ts`）。

## 4. 反向代理（**关键一步**）

### 4.1 nginx

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/lan-chess
sudo nano /etc/nginx/sites-available/lan-chess      # 改 server_name
sudo ln -s /etc/nginx/sites-available/lan-chess /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

必须配对的两件事（漏一个就是「页面能开、对局连不上」）：

1. `Upgrade` / `Connection` 头要透传；
2. `proxy_read_timeout` 要放大 —— **nginx 默认 60s 会把 WebSocket 掐掉**，
   表现是「玩着玩着突然掉线重连」。

HTTPS：`sudo certbot --nginx -d chess.example.com`。

### 4.2 Caddy（更省事，推荐只有一台机器时用）

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # 追加内容
sudo nano /etc/caddy/Caddyfile                          # 改域名
sudo systemctl reload caddy
```

Caddy 默认就支持 WebSocket 反代，还能自己签 HTTPS 证书 —— nginx 那份要手工配的
Upgrade 头和超时，它全自动。

### 4.3 防火墙

只放行 22 / 80 / 443，**3000 不要对公网开放**（反代在本机访问它就够）：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 5. 部署自检

```bash
cd /opt/lan-chess
npm run deploy:check                                   # 查本机
npm run deploy:check -- --url http://127.0.0.1:3000     # 等价写法
```

它一次查清云上最容易踩的四件事：

| 检查项 | 在盯什么 | 坏了怎么办 |
|---|---|---|
| HTTP 首页 | 服务起没起、反代转对端口没 | `systemctl status lan-chess` 看日志 |
| WebSocket `/ws` | 反代透传了没 | 补 `Upgrade` 头 + 放大 `proxy_read_timeout` |
| Stockfish 引擎 | 棋力够不够（查本机才有效） | `apt install stockfish`，或设 `STOCKFISH_PATH` |
| 数据目录 `.data` | 落盘写不写得进去 | 进程用户对该目录没写权限 → 别用 root |
| 服务端口 | 3000 有没有进程在听 | 服务没起或监听在别的端口/地址 |

从**另一台机器**查（用来验证反代链路）：

```bash
npm run deploy:check -- --url http://<公网IP>:3000   # 直连
npm run deploy:check -- --url https://chess.example.com  # 走反代 + HTTPS
```

## 6. 更新流程

**顺序不能错：先停服务，再构建，最后起服务。**

```bash
sudo systemctl stop lan-chess
cd /opt/lan-chess
git pull
npm ci
npm run build
sudo systemctl start lan-chess
npm run deploy:check
```

> ⚠️ **为什么必须先停**：`next build` 会**先清空 `.next` 再写**。运行中的生产服务器正在
> 读写同一个目录，构建期间它可能读到半成品（报错指向构建，真凶是那个还活着的服务）。
> 顺序错了就是「构建偶发失败 / 服务莫名 500」这种看着不相干的症状。

## 7. 棋力：装原生 Stockfish（可选）

引擎来源的优先级是「系统 stockfish → npm 的 WASM 版 → 自研引擎」：

```bash
sudo apt install stockfish          # Debian/Ubuntu
# 或者指到具体路径：
sudo systemctl edit lan-chess        # 加 Environment=STOCKFISH_PATH=/usr/games/stockfish
```

原生版带完整 NNUE、多线程，棋力最强；npm 那个 `stockfish` 包是纯 JS+WASM，跨平台都能跑，
棋力略低但完全够用；两个都没有就**自动降级到自研引擎** —— 照样能开局，AI 明显弱一档。

降级是**静默**的（只写进服务日志），所以「AI 棋力突然变弱」先查这一条。

## 8. 数据与持久化

- 房间状态落在 `<项目目录>/.data/rooms.json`、会话档案（token → 身份）落在 `.data/sessions.json`
  （都是节流 2 秒 + 原子替换）。存档目录可用环境变量 `LAN_CHESS_DATA_DIR` 改到别的盘。
- **云主机上这是普通目录**，重启不丢；容器部署记得给 `.data` 挂卷。
- 「对局不丢」靠它：服务重启后会**先恢复存档再开始监听端口**，所以玩家一连上就看到原来的局面，
  走子记录、棋钟、座位凭证都还在（恢复时重放走子重建棋局实例，
  否则「三次重复局面」的判定会永远失效）。
- **升级前写的旧存档也会被迁移**：旧格式的文件里直接就是房间快照（没有 `state` 外壳），
  服务启动时会被认出来并补齐缺字段，棋局状态保住，文件顺手升级成新格式。
  但旧存档**没有座位凭证** —— 那种对局里座位主人关掉网页后未必认领得回座位，
  这是旧存档本身的限制（凭证当时还不存在）。
- 「多个实例共享状态」**不靠**它 —— 状态在进程内存里，多进程各存各的。

## 9. 常见问题

| 现象 | 多半是 |
|---|---|
| 页面能开，但进不了对局 / 走子没反应 | 反代没透传 WebSocket（Upgrade 头 + 超时） |
| 玩着玩着掉线重连 | nginx `proxy_read_timeout` 默认 60s，把 ws 掐了 |
| 刷新后房间没了 / 座位显示幽灵 | `.data` 没写权限，或服务重启时房间被回收 |
| 关掉网页再打开回不去了 | 浏览器清掉了 localStorage（无痕模式 / 换设备 / 换浏览器），座位凭证没了 |
| AI 棋力明显变弱 | 引擎降级到自研引擎了，看日志 |
| `npm start` 报找不到模块 | 构建时裁掉了 devDependencies，`next build` 需要 typescript |
| 服务起不来，日志说端口占用 | 上一次没退干净，`lsof -nP -iTCP:3000 -sTCP:LISTEN -t` 查 |

> ⚠️ **查端口占用一定要带 `-sTCP:LISTEN`**。`lsof -i tcp:3000` 会把「连着这个端口的客户端」
> 也列出来 —— 自己的进程、浏览器辅助进程、甚至你正在用的浏览器，全会被一起 kill。

## 10. 已知限制（上云前要知道的）

1. **单实例**：状态在进程内存里，不能在后面挂 LB 复制多份。要多机就得先把状态挪到 Redis 之类的外部存储。
   （**为什么不能直接多开进程**见 §11）
2. **没有任何鉴权**：`hello` 只要给个名字就算身份，谁拿到地址就能建房、开局、给别人发私信。
   当前是「自己和熟人用」的定位；真要放开到公网，至少在反代上加一层 Basic Auth。
3. **不是 serverless 的料**：长连接 + 常驻进程 + Stockfish 子进程 + 20 秒级搜索，
   撞上函数时长限制和冷启动就会难用。要上 PaaS 得先拆成独立的 ws 服务。
   （**2026-11-20 复核**：Vercel 的 WebSocket 已在 2026-10-20 GA，「长连接不支持」这条
   已经不成立了 —— 但结论不变，理由换成 §16 里的 300 秒硬顶 + 内存态状态 + 落盘不成立。）
4. **「局域网」的措辞会不准**：启动横幅和 `npm run lan` 打的是内网 IP，云上应该是公网地址。
   只是文案层面的事，不影响功能。

---

## 11. 为什么「多开几个进程」不行（想清楚再决定要不要上 Redis）

看着像配置问题，其实不是 —— **每一份共享状态都在进程内存里**。挂两个进程（或同机两个端口 + LB），
它们各有一份，互不相通：

| 状态 | 代码位置 | 两个进程各干各的 → 现象 |
|---|---|---|
| 房间表 | `room-manager.ts:150` `private rooms = new Map()` | A 建的房 B **查不到** → 房间列表里没有它、按码加入报「房间不存在」 |
| 连接表 | `ws-hub.ts:93` `private clients = new Map()` | 同一房间的两个玩家落在不同进程 → **互相看不到对方的走子**（`broadcastRoom` 只广播给本进程连着的 socket） |
| 会话表 | `ws-hub.ts:95` `private sessions = new Map()` | 重连落到另一个进程 → token 查不到 → **身份变成新的**，座位丢失（sessions 虽然落盘，但**另一个进程不读它** —— 落盘只解决「重启」，不解决「多实例」） |
| 匹配队列 | `matchmaking.ts:49` `private queue: QueueEntry[]` | 队列裂成两半 → A 的人等不到 B 的人 |
| 落盘 | `store.ts` 整份写 `rooms.json` / `sessions.json` | 两进程**互相覆盖同一个文件** —— 后写的把先写的房间抹掉。这比「不共享」更糟，是数据损坏 |

大厅列表、在线名单、私信同理，全是进程内视图。

**要真多实例，共享状态必须外置**：

- 房间/对局 → Redis（存 `RoomState`，带乐观锁防并发改）
- 匹配队列 → Redis list/zset（配对要原子，Lua 或 `SETNX`）
- 广播 → Redis pub/sub（一进程收到走子 → publish → 各进程转发给自己连着的 socket）
- `.data/rooms.json` → 去掉，或只让一个进程写
- 房间清理定时器 → 要加分布式锁，否则两个进程同时清理同一房间

工作量相当于**重写 `room-manager` + `ws-hub` 的状态层**（协议和前端基本不动）。
对「自己和熟人用」不划算 —— 真要扛几百人再上。

**更便宜的两条路**（不用 Redis）：

1. **按房间码做进程间路由**：同机开 N 个端口，前面一层按 4 位房间码把请求转给对应端口。
   这样「同一房间的两个人永远在同一个进程」，房间内对局是对的；但大厅列表、匹配队列、
   私信仍然各看各的 —— 只能解决一半。
2. **单进程多开房间**（现状）：一局 2 人 + 观战几十人，单实例轻松。先量真实并发再决定要不要上 Redis。

## 12. 上云的安全底线（比「零鉴权」更隐蔽的一条）

**必须上 HTTPS / WSS。** `hello` 用的 **session token 是通过 WebSocket 明文过网的**
（`hello {name, token}` → 服务端拿 token 认人，`ws-hub.ts:276`）。
只开 http 的话，中间人抓一次包就能拿到 token，然后**冒充你**——认输、开房、发私信都能冒名。

所以：

- 反代必须配 TLS（Let's Encrypt，Caddy 会自动签）；
- `3000` 端口只监听 `127.0.0.1`（systemd 里把 `HOST` 改成 `127.0.0.1`），别直接对公网开；
- 防火墙只放行 22 / 80 / 443。

## 13. 资源建议

引擎实例数上限跟着 CPU 核数走：`Math.max(1, Math.min(4, cpus - 1))`（`engine-pool.ts:118`），
每个引擎 `Hash 64MB` + `Threads 2`。2 核机器只开 1 个引擎，4 核 3 个，8 核封顶 4 个。

| 规格 | 建议 |
|---|---|
| 2 核 4G | **够用**（自己和几十人），推荐起步 |
| 2 核 2G | 能跑，但同时开好几个引擎容易 OOM |
| 1 核 1G | 不建议 —— Next + Stockfish + WS 长连接挤在一起 |

内存吃紧的话可以把引擎哈希调小（`uci-backend.ts` 的 `hashMb`），或装原生 Stockfish
（同样的哈希占用下，原生版更快、内存更省）。

---

## 14. 一次真实体检记录（2026-11-12）

> ⚠️ **脱敏说明**：本节与 §15 记录的是一次真实的共享生产机体检 + 证书修复事故。
> 为避免公开仓库泄露实际基础设施，**公网 IP、域名、端口号、备份路径、证书日期已全部替换为
> 占位符**（`<ECS 公网 IP>` / `<站点 N>.example.com` / `<PORT_A>` / `<日期>` …）。
> 技术结论、排查路径与修法**一字未改** —— 这套记录的价值在方法，不在具体数字。

在 `<ECS 公网 IP>`（一台自用的阿里云 ECS）上实测过一次，结论如下 —— **这台机器不能按
「标准流程」部署**：

| 项 | 实测值 | 结论 |
|---|---|---|
| 系统 | Ubuntu 22.04.5 LTS / 内核 5.15 | ✅ |
| Node / npm | v22.22.2 / 10.9.7 | ✅ 满足 ≥18.17 |
| git / nginx / ufw / python3 | 都在 | ✅ |
| 磁盘 | 59G，剩 38G | ✅ |
| 3000 端口 | 空闲 | ✅ |
| npm 源 / github | 通（registry 74ms） | ✅ |
| **内存** | **总 1586MB，开机已占 1000MB**（有个 node 占 675MB）→ 可用仅 **403MB** | ❌ **瓶颈** |
| **swap** | 4G，`npm ci` 时峰值已用 1257MB | ❌ 构建直接打满 |
| **stockfish** | 没装 | ⚠️ 走 npm WASM 版（棋力弱一档） |
| **ufw** | **inactive**，且 <PORT_A> / <PORT_B> 直接监听 `0.0.0.0` | ⚠️ **公网可直连**（球球决定**暂不处理**，见 §15.4） |
| nginx | 已被 4 个站点占着 80/443 | ⚠️ 加站点要新写 server 块 |
| 证书 | **acme.sh** 签的（`/root/.acme.sh` + `/etc/nginx/ssl`），不是 letsencrypt | ⚠️ 照 acme.sh 的路子签 |

**这台机器上还跑着**：`example.com` 系列 4 个站点、docker(<DOCKER_PORT>)、自研网关(<GATEWAY_PORT>)、
两个 nvm node 服务(<PORT_A>/<PORT_B>)。**它不是专用机** —— 在上面跑 `next build` 会把整机打到僵死，
那 4 个线上站点会一起挂（实测：构建开始后 SSH banner 超时、4 个站点全部 HTTP 000，
只有 ping 还通）。**只能从阿里云控制台重启才能救回来。**

所以这台机器的正确用法：

1. **构建在本地做**，把 `.next` + `node_modules` 传上去（见 §2 的警告框）；
2. 跑的时候 `HOST=127.0.0.1`，nginx 反代只放行 443/80；
3. 证书用 acme.sh 签，nginx 加一个 server 块；
4. <PORT_A> / <PORT_B> 那两个裸奔的端口用 ufw 收一下（只放行 22/80/443）—— **目前球球决定暂不动**，
   但只要这台机器还在公网，这条就是敞着的风险（见 §15.4）。

> **给 agent 的规矩**：上别人的/共享的机器做实测，**先只读体检**（系统、内存、已有服务、
> 端口、工具链），把结论报给用户，**别直接上重任务**。装依赖能过 ≠ 能构建。

---

## 15. 这台机器上的证书修复记录（2026-11-12，与 chess-game 无关的附带工作）

体检时顺带发现：4 个站点的证书里**有 3 个已经过期或即将过期**，且**每日续签是失败的**
（acme.sh 日志明写 `tcp port 80 is already used by nginx`）。球球授权后已全部修好。
本节记下来，是因为**这套修法对以后在这台机器上签任何新域名都适用**。

### 15.1 根因

acme.sh 之前用的是 **standalone** 模式：签发时要自己占住 80 端口，但 nginx 常年占着 80，
于是每天 00:49 的续签 cron 全军覆没。三个域名的 `notAfter` 分别停在 <过期日期 A> /
<过期日期 B> / <过期日期 C> —— 都早于出问题的时间，说明**它们是一次性签的、之后再没续上**。

另有三个叠加因素：

1. **80 端口块里没有 challenge 路径**。有的 server 块在 server 级写 `return 301 https://...`
   或 `rewrite`，这两个都在 **rewrite 阶段**执行，**早于 location 匹配** → ACME 的验证请求
   根本到不了 `/.well-known/acme-challenge/`，直接被 301 跳走。
2. **续签成功但没同步给 nginx**。有一个域名续签本身是成功的，但证书文件写到了 acme.sh
   自己的目录，nginx 读的是另一个路径 → nginx 一直用着旧证书。
3. **`cp -a` 备份软链等于没备份**。`sites-enabled/` 里多数是软链，`cp -a` 复制过去还是软链，
   指向的源文件一改就一起变。备份必须 `cp -aL` 解引用。
   另外备份文件**不能留在 `sites-enabled/` 里** —— `include /etc/nginx/sites-enabled/*`
   会把它当正常配置加载，变成重复 server 块。

### 15.2 修法：统一改用 webroot 模式

不再抢 80 端口，改成让 nginx 负责把验证请求从磁盘读出来：

```bash
# 1) 挑战目录
mkdir -p /var/www/acme-challenge/.well-known/acme-challenge

# 2) 80 端口块里单开一个口子（关键：必须用 location，不能用 server 级 return）
location /.well-known/acme-challenge/ {
    root /var/www/acme-challenge;
}
location / {
    return 301 https://$host$request_uri;
}

# 3) 签发 + 安装 + 续签后自动 reload
/root/.acme.sh/acme.sh --issue -d <domain> --ecc --webroot /var/www/acme-challenge --force
/root/.acme.sh/acme.sh --install-cert -d <domain> --ecc \
  --fullchain-file <nginx 读的 cert 路径> \
  --key-file <nginx 读的 key 路径> \
  --reloadcmd "systemctl reload nginx"
```

`--install-cert` 会把 `Le_RealFullChainPath` / `Le_RealKeyPath` / `Le_ReloadCmd` / `Le_Webroot`
写进 `/root/.acme.sh/<domain>_ecc/<domain>.conf`，**以后每日 cron 续签成功后会自动覆盖文件
并 reload nginx**，不需要人工介入。

### 15.3 修完后的状态（已复检）

| 域名 | 到期 | HTTP | 说明 |
|---|---|---|---|
| `http.<站点1>.example.com` | <续签日期 A> | 200 | 改 webroot 重签 |
| `ai.coding.<站点2>.example.com` | <续签日期 A> | 200 | 改 webroot 重签 |
| `<站点3>.example.com` | <续签日期 B> | 200 | 原本就正常，未改动 |
| `<站点4>.example.com` | <续签日期 C> | 403 | 沿用现成证书，只做 install-cert + 同步路径；403 是站点根目录没有 index 的正常响应 |

- 四个域名外部 TLS 握手 `ssl_verify_result=0`，无 verify error；
- 四个域名的 conf 都已写入 `Le_ReloadCmd` 与 `Le_Webroot`；
- `nginx -t` 通过；
- 端到端验过 challenge 路径：往 webroot 丢一个探针文件，三个域名 HTTP 访问都拿到
  `200` + 正确 body —— 这才是「续签一定能走通」的真凭据，而不是只看证书日期。

### 15.4 仍然敞着的风险（球球决定暂不处理）

`<PORT_A>` / `<PORT_B>` 两个 node 服务监听 `0.0.0.0`，且 **ufw 是 inactive** → 公网可直连。
球球明确表示**先不动**，所以只做记录：

> 只要这台机器在公网，这两个端口就一直开着。哪天要收，标准做法是
> `ufw allow 22/80/443` + 默认 incoming drop。**注意**：docker 发布的端口
> （本机 <DOCKER_PORT>）走的是 `DOCKER-USER` 链，ufw 的 default 策略不一定管得住，
> 得单独确认一遍。

### 15.5 备份位置

`/root/nginx-backup-<日期>/`（`cp -aL` 解引用后的真实副本，含 `<站点4>` 的 live 配置，
单独存成 `.LIVE`）。**在 `sites-enabled/` 之外**，不会被 nginx 加载。

### 15.6 这次事故的通用教训

1. **共享生产机上不要构建** —— 见 §2 的警告框。这次实测把 4 个线上站点一起拖垮，
   只有阿里云控制台重启能救（agent 做不到这件事，必须第一时间请用户操作）。
2. **证书「续签 cron 存在」不等于「续签在跑」** —— 要去翻 acme.sh 的日志确认，
   并真的从外部 HTTP 打一次 challenge 路径。
3. **备份软链要用 `cp -aL`** —— 否则你以为有备份，真出事时发现它跟着源文件一起被改了。

---

## 16. 能不能直接上 Vercel 免费版做公网对战？（2026-11-20 核查）

> 结论：**Next.js 这一半可以，实时对战这一半不行。** 想公网玩，得把两半拆开部署。

### 16.1 Vercel 现状（查的是官方文档原文，不是二手博客）

用 CLI 就能直接读官方文档：

```bash
npx vercel@latest docs search "websockets"     # 搜文档
npx vercel@latest docs inspect <page>          # 打印某页 Markdown
```

也可以直接抓 `.md` 端点（免登录）：`https://vercel.com/docs/functions/websockets.md`。

关键事实：

| 事实 | 来源 |
|---|---|
| **WebSocket 已 GA**（2026-10-20），全套餐含 Hobby 可用，需开 Fluid compute | Vercel changelog / docs/functions/websockets |
| Next.js **没有**内置 WS upgrade API，要用 `@vercel/functions` ≥ 3.10.0 的 `upgradeWebSocket()` 写在 Route Handler 里 | 同上，官方 Next.js 小节 |
| **Hobby 函数时长：默认 300 秒 = 上限**，硬顶，Pro 才能到 800s | docs/functions/limitations |
| 重连**不保证**落到同一个实例 | 官方原文：*not guaranteed to reach the same Vercel Function instance* |
| Hobby：100GB 流量/月、100 万函数调用/月、2GB 内存、100 次部署/天 | docs/pricing |

### 16.2 为什么这个项目上不去（按阻塞程度排序）

1. **自定义服务器根本不会跑。** Vercel 对 Next.js 项目用自己的 serverless 适配器，
   `start` 脚本被忽略。`server.ts` 里那套 `server.on('upgrade')` + `ws` 的
   `WebSocketServer({ noServer: true })` 完全用不上，必须改写成 Route Handler +
   `upgradeWebSocket()`，而 `WsHub` 现在吃的是 `ws` 的 `WebSocket` 类型 —— 要加一层适配。
2. **300 秒硬顶会把长对局掐断。** 时限档位有 `5+0 / 10+0 / 15+10 / 30+0`（默认 `10+0`），
   一局必然超过 5 分钟。官方写明连接在函数达到最大时长时关闭 —— 免费版就是**每 5 分钟断一次**。
3. **重连可能落到别的实例 → 房间直接没了。** 房间表 / 连接表 / 会话表 / 匹配队列
   全在进程内存（见 §11 那张表）。落到别的实例 = 「房间不存在」、座位丢失、身份变新人。
   项目里有重连逻辑（`verify:reconnect`），但它救不了「状态在别人进程里」。
4. **落盘不成立。** Vercel 文件系统除 `/tmp` 外只读、实例间不共享、随实例回收。
   `.data/rooms.json` + `sessions.json` 承诺的「重启不丢对局」「重连还认得回你」两件事都没了。
5. **Stockfish 子进程不划算。** `engine-pool.ts` 懒启动 spawn 子进程（最多 `min(4, cpus-1)` 个）。
   函数里能 spawn，但每次冷启动都要重启引擎池；Hobby 只有 4 CPU-hours/月 Active CPU，
   而**连接开着就一直按实例存活时长计内存费**（不是按消息量）。
6. **零鉴权。** `hello` 给个名字就算身份，地址一旦公开谁都能建房、开局、发私信。
   公网暴露前至少要垫一层 Basic Auth（§12）。

### 16.3 能干净上 Vercel 的部分

5 个页面**全是 `'use client'`**，没有任何 route handler / API 路由 / 服务端数据获取：

```
/            ○  静态      /pieces    ○  静态      /practice  ○  静态
/pieces3d    ○  静态      /room/[code]  ƒ  按需渲染（无 generateStaticParams）
```

实测 `next build` 通过（7/7 静态页生成成功）。也就是说 **纯 UI 部分（棋盘、3D 棋子、
教学、练习）可以零函数成本托管在 Vercel Hobby 上**，只有 `/room/[code]` 会产生函数调用
（Hobby 有 100 万次/月，够用）。

### 16.4 三条可行路线

| 路线 | 改动 | 评价 |
|---|---|---|
| **A. 拆分：前端 Vercel + WS 服务留 VPS** | `useSocket.ts:418` 的 `window.location.host` 改成读 `NEXT_PUBLIC_WS_URL` | 改动最小。跨源 WS 不受同源策略限制，且 `ws-hub.ts` 里**没有** Origin 校验，跨源能连。WS 服务仍按本文 §1–§13 部署（要 WSS） |
| **B. 全部留在自己的 VPS** | 零代码改动 | 最省事。本文 §1–§13 就是为此写的。注意 §2 的警告：**别在共享生产机上构建** |
| **C. 真要全上 Vercel** | Route Handler + `upgradeWebSocket()` + 状态外置 Redis/KV + 存档外置 + 引擎另找方案 + 断线重连协议 | 工作量 ≈ 重写 `room-manager` + `ws-hub` 的状态层（§11 已估过）。**且 300 秒上限还在** —— 免费版仍每 5 分钟断一次，要「免费 + 长对局不中断」在 Vercel 上做不到 |

**给「自己和熟人玩」的建议是 A 或 B**，不要碰 C。

---

## 17. 混合部署：页面在 Vercel + 实时服务在自己的服务器（2026-11-23）

> §16 说「不能全上 Vercel」，但**可以拆开上** —— 这就是路线 A 的完整落地。
> 关键收益：**服务器上不用构建 Next.js**，于是那台 1586MB 的机器彻底躲开了
> 「构建把整机拖下水」这个坑（§2 的警告框）。

### 17.1 架构

```
浏览器 ──── https://<app>.vercel.app ────▶ Vercel（页面，全静态，零函数成本）
  │
  └──── wss://<你的域名>/ws ────▶ nginx :443（TLS 终止）
                                    │
                                    └─▶ 127.0.0.1:3000  server-ws.ts（只跑 WS）
                                          ├─ 房间/匹配/会话：进程内存
                                          ├─ 存档：.data/rooms.json + sessions.json
                                          └─ AI：Stockfish 子进程
```

**跨源没问题**：浏览器对 WebSocket 不适用同源策略，服务端也没做 Origin 校验
（已核对 `src/server/ws-hub.ts`）。但公网开放前建议在 nginx 加一条 Origin 白名单
（`deploy/nginx-hybrid.conf.example` 末尾有现成的写法）。

### 17.2 代码侧的改动（已落地）

| 文件 | 改动 |
|---|---|
| `src/lib/ws-url.ts` | 新增。算 WS 地址：配了 `NEXT_PUBLIC_WS_URL` 就连它，否则退回同源 |
| `src/hooks/useSocket.ts` | 用 `resolveWsUrl()` 取代写死的 `window.location.host` |
| `server-ws.ts` | 新增入口。**只跑 WebSocket，不加载 Next.js** |
| `scripts/verify-ws-only.ts` | 新增门禁，守的就是这条部署路径 |
| `tests/ws-url.test.ts` | 地址解析的单测 |
| `package.json` | 加 `start:ws` / `verify:ws-only` 脚本；加 `engines.node=22.x` |

⚠️ **`NEXT_PUBLIC_WS_URL` 必须写成静态成员访问**（`process.env.NEXT_PUBLIC_WS_URL`）——
Next.js 只对这种写法做构建期内联。写成 `process.env[key]` 或先解构再取值，
浏览器里拿到的是 undefined，**静默退回同源**，表现是「页面在 Vercel，
但连的还是 vercel.app/ws」。

### 17.3 Vercel 侧

```bash
npm i -g vercel          # 已经有 66.6.0
vercel login             # 或用 VERCEL_TOKEN
vercel --prod
```

**部署前必须在项目设置里配好环境变量**（或 `vercel env add NEXT_PUBLIC_WS_URL production`）：

```
NEXT_PUBLIC_WS_URL = wss://<你的域名>/ws
```

- 这是**构建期**变量：改完要**重新部署**才生效（不是运行时读）。
- Hobby 是个人/非商用用途 —— 自己玩没问题；一旦拿来盈利要升 Pro。
- 5 个页面全是 `'use client'`，没有 route handler → Vercel 上**几乎不产生函数调用**，
  只有 `/room/[code]` 按需渲染会算。

### 17.4 服务器侧（不用构建！）

```bash
# 1. 拉代码（仓库是公开的，直接 clone）
sudo git clone --depth 1 https://github.com/shaoyahu/chess.git /opt/lan-chess
sudo chown -R lan-chess:lan-chess /opt/lan-chess
cd /opt/lan-chess

# 2. 装依赖 —— 注意**没有 build 这一步**
sudo -u lan-chess npm ci --omit=dev

# 3. systemd 单元（用 WS-only 那个）
sudo cp deploy/lan-chess-ws.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lan-chess-ws

# 4. nginx：加 location /ws（见 deploy/nginx-hybrid.conf.example）
sudo nginx -t && sudo systemctl reload nginx
```

**为什么不用传 `.next`**：WS-only 入口不加载 Next.js，服务器上根本不需要构建产物。
这既是省事，也是**安全**——§2 那个「构建把 1586MB 的机器打到僵死」的坑直接绕开了。

⚠️ 服务器上跑的是 **GitHub 上的 main**。本地没提交的改动不会上去。

### 17.5 自检

```bash
# 本地：门禁（起一个隔离端口 + 隔离存档目录的 WS-only 服务）
npm run verify:ws-only

# 服务器上
curl -s http://127.0.0.1:3000/healthz          # {"ok":true,"mode":"ws-only"}
systemctl status lan-chess-ws
journalctl -u lan-chess-ws -n 50 --no-pager

# 端到端：浏览器打开 Vercel 页面 → 建房 → 换个浏览器/无痕窗口加入 →
#          两边走子同步 → 看状态行和棋钟是不是同时在动
```

### 17.6 这条路的已知代价

1. **两处部署、两处运维**：Vercel 一次 push 一遍，服务器一次 `git pull` + 重启。
2. **服务器上仍是单实例**：内存态房间/匹配 —— 想扛几百人才需要上 Redis（§11）。
3. **内存要算一下**：这台机器上还有别的服务，Stockfish 是主要消耗。
   建议装**原生** Stockfish（同哈希更省内存），并把引擎实例数压到 1
   （`engine-pool.ts` 按核数推算：2 核机器本来就只开 1 个）。
4. **零鉴权**：公网开放前至少加 nginx 的 Origin 白名单（§17.1 末尾）。

### 17.7 实际部署记录（2026-11-23，已上线）

> ⚠️ **脱敏说明**：本节的真实域名、账号已替换为占位符（`<WS 域名>` / `<Vercel 账号>`），
> 避免公开仓库泄露实际基础设施。技术结论、命令、路径写法**一字未改** —— 价值在方法。

| 位置 | 内容 |
|---|---|
| 页面 | `https://lan-chess.vercel.app`（Vercel Hobby，账号 `<Vercel 账号>`，项目 `lan-chess`） |
| WebSocket | `wss://<WS 域名>/ws`（DNS A 记录 → 这台机器；nginx 443 终止 TLS） |
| 实时服务 | 这台机器上的 `lan-chess-ws.service`（systemd，只跑 WS，不加载 Next.js） |
| 证书 | acme.sh ECC，webroot `/var/www/acme-challenge`，装在 `/etc/nginx/ssl/<WS 域名>.*`，续签后自动 `systemctl reload nginx` |

**实测数据**：Node 进程常驻内存 **18.8MB**（整站 Next.js 版要 150MB+）；
磁盘占用 739MB（`node_modules`）；这台机器上还有 4 个线上站点，内存余量 536MB。

**端到端验证过**（真浏览器，不是脚本）：

1. Vercel 首页加载 → 状态灯「已连接，在线 0 人」
2. 输入用户名进大厅 → 「在线 1」，大厅列表正常
3. 建房 → 跳到 `/room/26MC`，棋钟 10:00 走起来，2D/3D/聊天/棋谱都在
4. 刷新页面 → 房间还在（服务端内存态 + 落盘都正常）
5. 公网 WSS 握手（脚本）→ `session` + `lobby` 都收到

### 17.8 装证书时踩的坑：acme.sh v3 的短参数不能用

acme.sh **v3.1.3** 上，webroot 模式的短参数 `-w` 会被误解析：

```
Unknown parameter: /var/www/acme-challenge
```

用**长参数**就正常：

```bash
/root/.acme.sh/acme.sh --issue --domain <WS 域名> --webroot /var/www/acme-challenge --ecc
```

装证书（沿用机器上其他域名的约定，`--reloadcmd` 负责续签后自动重载）：

```bash
/root/.acme.sh/acme.sh --install-cert -d <WS 域名> --ecc \
  --key-file /etc/nginx/ssl/<WS 域名>.key \
  --fullchain-file /etc/nginx/ssl/<WS 域名>.fullchain.cer \
  --reloadcmd "systemctl reload nginx"
```

**签发顺序**：先建 80 端口的 server 块（带 `location /.well-known/acme-challenge/`）→ reload →
签证书 → 再加 443 的 server 块。证书不存在时 443 块会让 `nginx -t` 失败。

### 17.9 Origin 白名单（已启用）

```nginx
location /ws {
    # 空 Origin（非浏览器客户端，比如门禁脚本）也放行 ——
    # 所以用正则的一个空分支来写，不能用 `!= ""`
    #（nginx 的 if 左边是变量时不支持 !=）。
    if ($http_origin !~* "^(|https://(lan-chess\.vercel\.app|lan-chess-[a-z0-9-]+\.vercel\.app|chess\.example\.com))$") {
        return 403;
    }
    ...
}
```

**它防什么、不防什么**（别把它当身份认证）：

- ✅ **防**：别的网站把本服务器塞进自己页面 —— 访客的浏览器会替攻击者连上来建房、发私信。
  实测部署完几小时内，nginx 日志里已经出现多个陌生 IP 在扫 `/` 和 `/favicon.ico`。
- ❌ **不防**：脚本攻击者 —— 非浏览器客户端可以自己编 Origin 头，甚至不带。
  真要挡住，得在 `hello` 里加口令（**改代码**，见 §12）。

### 17.10 以后怎么更新

⚠️ **Vercel 这边没接 GitHub 自动部署** —— `vercel link` 时报
「You need to add a Login Connection to your GitHub account first」。
所以现在每次更新要手动跑一次 CLI：

```bash
# 1. 服务器：拉代码 + 重启
ssh server 'cd /opt/lan-chess && sudo -u lan-chess git pull && sudo systemctl restart lan-chess-ws'

# 2. Vercel：重新部署（会带上本地的改动）
cd /path/to/chess-game && vercel --prod
```

想让 `git push` 自动触发 Vercel 部署：在 Vercel 项目设置里接一个 GitHub Login Connection，
之后 `vercel git connect` 即可。

**⚠️ 两边必须同源**：Vercel 部署的是**当前工作目录**的内容（`vercel --prod` 会把本地改动一起传上去），
服务器跑的是 **GitHub main**。本地改了没提交就部署 → 两边代码不一致 → 前端会等一个服务端不认的协议
（表现为「按钮永远灰着」这类界面在骗人的症状）。**所以：先提交推送，再部署。**

### 17.11 容量：实测能承受多少玩家

> 数据来自 2026-11-23 在本机的实测。**153 条连接是稳态数据**；
> 500 条那次把机器压僵了（见 §2 的禁令），所以**拐点没测出来**。
>
> 🚫 **2026-11-27 起这条路彻底关闭**：球球拍板 —— 小项目不做压测（§2）。
> 下面的数字只当**历史记录**，**不要再复现、也不要再补测**。

**153 条并发连接（每条都完成 hello、有身份）：完全无压力**

| 指标 | 空闲 | 153 条连接 |
|---|---|---|
| Node 进程内存 | 48MB | **48MB（纹丝不动）** |
| 系统可用内存 | 534MB | 457MB（**每连接约 500KB**） |
| ping-pong 延迟 | 45ms | **41ms（零劣化）** |
| 负载均值 | 0.2 | 0.2–0.58 |

**结论：连接的成本几乎全在「内核 socket 缓冲」，不在 Node 堆里** ——
服务端每条连接约占 500KB 系统内存、Node 侧几乎免费。

**为什么房间数不会线性吃 CPU**：定时器是**全局一个**，不是每房间一个：

- `ws-hub.ts` 里 `setInterval(onTick, 1000)` 只有一处，`onTick()` 只广播**有变化的**房间；
- 心跳、清理落盘也都是全局定时器；
- 所以「房间数」带来的成本是**每房间每步一条消息**，不是每房间一个定时器。

**人机对局才是真瓶颈**（AI 走 Stockfish **子进程**，不阻塞事件循环）：

引擎池上限是 `min(4, 核数-1)` —— 这台 2 核机器**只能开 1 个引擎**，
所有 AI 房间共用它，思考是**串行**的：

| 难度 | 每步预算 | 单引擎理论并发 AI 房间 |
|---|---|---|
| easy | 200ms | ~100 个 |
| normal | 800ms | ~25 个 |
| **hard** | **2500ms** | **~8 个** |

再加一条：每个 Stockfish 子进程约吃 150–200MB 内存（Hash 64MB + 2 线程），
这台机器只剩 500MB 出头。

**实际建议**：

- **纯人人对局**：几十到一两百人同时在线没问题（实测 153 人零劣化）。
  再往上要先扩内存 —— 每连接约 500KB，1000 人 ≈ 500MB。
- **人机对局**：同时进行的 AI 房间**建议控制在 10 个以内**（hard 档 8 个就到顶）。
- 想再往上，三个杠杆按性价比排：
  1. **给引擎池加实例**（`engine-pool.ts` 的 `maxWorkers`）—— 2 核上开到 2，
     AI 并发翻倍，但会抢事件循环的 CPU，**必须实测**（而且只能去别的机器测，见 §2）；
  2. **换原生 Stockfish** —— 同哈希下更省内存更快，但版本可能过不了 `verify:stockfish`；
  3. **换机器** —— 4 核 8G 的话，人机房间能到几十个同时开。

### 17.12 三个「别踩」的坑（实测）

1. **`nginx -t` 的退出码会被管道吞掉**。`nginx -t 2>&1 | tail -3 && systemctl reload nginx`
   —— 管道后面是 `tail` 的退出码（永远 0），**配置写错了照样会执行 reload**。
   要判断就用 `nginx -t` 单独跑，看它自己的退出码。
2. **reload 失败不会打断服务**：nginx 拒绝坏配置、保留旧配置继续跑。所以「reload 报错」不等于「网站挂了」，
   但也**不等于新配置生效了** —— 一定要再 `nginx -t` 确认一次。
3. **`git clone` 之后属主变了**，`git log` 会报
   `detected dubious ownership`。解法是 `git config --system --add safe.directory <路径>`
   （放系统级，不要用 `--global` —— 服务用户的 HOME 在项目目录里，会往仓库里塞 `.gitconfig`）。

## 18. 僵死事故复盘（2026-11-27：同一台机器第二次僵死）

> §2 已经写了「禁止在这台机器上压测」的禁令。本节记的是**第二次**僵死 ——
> 也就是说：**禁令写了，它还是又死了一次**。
>
> ⚠️ **但两次的死因不一样**（取证结论见 §18.2）：11-23 那次确实是压测压死的（有 OOM 记录），
> **这次不是** —— 这次没有任何 OOM 记录，是系统被**渐进拖垮**的。
> 所以 §2 的禁令依然有效（那台机器确实扛不住压测），
> 但**光有禁令不够**：还得把「机器为什么会慢慢变糟」这件事查清楚并修掉。

### 18.1 事实（可复现的外部证据）

- **2026-11-23 18:31** 从云控制台重启后，这台机器**完全恢复**：
  5 个站点全部响应、nginx / `lan-chess-ws` / docker 全部 `active` 且开机自启、
  被 OOM killer 干掉的几个 node 服务都自己回来了、公网 WSS 握手成功、
  存档里 409 条压测会话清理到 3 条。
- **2026-11-27 14:09** 第一次接触这台机器时，它**已经僵死**，外部特征与 11-23 **逐条一致**：

  | 观测 | 结果 | 说明 |
  |---|---|---|
  | `ping` | 通，0% 丢包 | 网络没问题 |
  | 22 / 80 / 443 | **TCP 握手成功，应用层无响应** | 内核还在应答，用户态已经跑不动了（SSH 卡在 banner exchange、HTTP 20s 返回 000） |
  | 其余服务端口 | **连握手都不上** | 用户态被拖垮到连 accept 都做不了（**注意**：后来取证**没有**发现 OOM 记录，见 §18.2） |

- **僵死窗口 = 11-23 18:32（最后一次确认健康）~ 11-27 14:09（第一次发现僵死）**，约 4 天。
  从机器外部**没法再收窄**：TCP 握手成功只证明内核活着，不证明用户态活着
  （僵死时 nginx 的监听套接字仍在内核 backlog 里排队，新连接照样能握上手）。

### 18.2 归因：**重启后翻 journal 得到的结论**

> ⚠️ 这一节是 **2026-11-27 14:28 重启后取证**的结果，
> 和「僵死当天只能猜」的版本**不一样**。
> 留档的意义就在这儿：把**被推翻的推断**也写下来 ——
> 下次别再拿「特征一样」当「原因一样」。

**A. 确定的（有 journal 直接证据）**

1. **本轮（11-27）没有对这台机器做任何写操作**：没构建、没压测、没重启、没改配置；
   14:09 之前从未连过它 —— 第一次接触就已经僵死了。→ **本轮不是起因。**
2. **服务器上跑的还是 11-23 的代码**（今天 14:5x 才第一次 `git pull`）→ 今天的代码改动不可能是起因。
3. **这次僵死里没有任何 OOM 记录**。上一个 boot 的内核日志**是有记录的**（750 行），
   `journalctl -b -1 -k | grep -iE "out of memory|oom-kill|killed process"` **一条都没有**。
   → **§2 里写的死法（内存耗尽 → OOM killer 收割 → swap 颠簸）不能直接套到这次。**
   11-23 那次的机制（确实有 OOM 记录）这次并不成立。
4. **退化是渐进的，有明确时间线**（全部来自 `journalctl -b -1`）：

   | 时间 | 发生了什么 |
   |---|---|
   | 11-25 06:29 | `snapd.service` 触发看门狗超时（5 分钟无响应）→ 被 SIGABRT 打死 |
   | 11-25 06:29 之后 | **snapd 进入崩溃-重启循环**：每次启动都卡满约 7 分钟才超时被杀，重启计数一路涨到 **902** |
   | 11-25 16:34 | **本服务的存档开始写不进去**：`rename ... ENOENT` —— **连续 46 小时** |
   | 11-25 18:28 | 内核记录 `hrtimer: interrupt took 14634321 ns`（14.6 毫秒）→ 系统已经在长时间卡顿 |
   | 11-26 00:48 | **最后一条内核日志**（loop8 容量变化）—— 此后内核再没说过话 |
   | 11-27 14:05~14:09 | SSH 开始握不上手（本服务还在写日志 → 进程还活着，只是系统被拖垮） |
   | 11-27 14:20 | 控制台按电源键 → `Failed to execute poweroff operation: Connection timed out` —— **连关机都执行不了** |
   | 11-27 14:28 | 重启成功 |

5. **存了 46 小时的档是坏的，而且没人知道**：`.data` 的写盘从 11-25 16:34 起就在报
   `ENOENT`（tmp 文件刚写完就不见了），服务端只是把错误打进 journal。
   → **根因是我们自己的代码**（原子写用了**固定的**临时文件名，并发写互相抢），
   **已修**（见 §18.7）。

**B. 推断（证据强度：中）**

6. 机器是被**资源饥饿**拖垮的（CPU / IO / swap 颠簸），
   但**具体是谁吃掉的，取证没能定死** —— 那个窗口里没有监控数据，内核日志在 11-26 就断了。
   最可疑的长期因素是这台 1586MB 的机器同时扛着 4 个站点 + openclaw（RSS 327MB，
   这台机上最大的进程）+ docker + 两个 node 服务 —— 任何一处泄漏都会互相挤压。
   **snapd 那 900 多次重启循环**是同期最显眼的后台异常，但它每次只吃 1.5 秒 CPU，
   单看不像元凶，更像「系统已经在变糟」的**症状**。

**C. 仍然定不下来的**

7. 最后一根稻草具体是什么 —— 没有那几天的监控数据，**编不出来，也不该编**。
   要下次能定死，得先有监控（见 §18.7）。

### 18.3 结构性脆弱点：就算没人压测，它也随时可能再死

这一节与本次归因无关，但决定了「**下一次还会不会死**」。以下都是代码/配置里
能直接读出来的事实（行号以 `src/server/ws-hub.ts` 为准）：

1. **大厅广播是 O(n²)**。每个客户端登录都会走 `handleHello` → `broadcastLobby()`（L360）；
   而 `broadcastLobby()`（L1230）把**完整大厅**（含**全部在线用户**）发给**每一个**连接，
   且 `send()`（L1163）对每个连接**单独 `JSON.stringify` 一次**。
   连接越多 → 单次广播越胖 → 再乘以连接数。
   累计序列化量 ≈ Σ k² ≈ O(n³)/3：500 条连接依次登录，累计写出量是 **GB 级**。
2. **`send()` 不看背压**：`socket.send()` 的返回值被忽略（L1166）。
   慢客户端（或者刚握手成功还没开始读的客户端）的写缓冲在内存里**无上限堆积** ——
   单个慢连接就能把内存吃光。
3. **没有任何连接数上限**：代码里没有 `MAX_CLIENTS`，nginx 示例里也没有 `limit_conn`。
   nginx 的 Origin 白名单只能挡浏览器，**挡不住脚本**（脚本可以随便伪造 Origin）。
4. **零鉴权 + 公网暴露**：拿到地址的人就能开连接、建房、跑 AI —— 而 AI 会拉起
   Stockfish 子进程（每个 150–200MB，§17.11）。
5. **systemd 单元没有内存上限**（`deploy/lan-chess-ws.service` 里没有 `MemoryMax`）：
   OOM killer 会按进程大小挑牺牲品，于是**这个服务把内存吃光时，被杀的是别人的服务**。

### 18.4 硬禁令（下次不要做）

1. ❌ **不要在这台机器上做压测 / 压力测试 / 容量测试**，任何连接数、任何脚本。
   要测容量去本地或一次性小机器测（§2、§17.11）。**这次它又死了一次 —— 代价是
   连坐了另外 4 个线上站点。**
2. ❌ **不要在这台机器上 `npm ci` / `next build`** —— 构建峰值能打死 1586MB 的机器（§2）。
3. ❌ **不要留任何「长时间连接」脚本在这台机器上跑**，哪怕只想测 10 条：
   脚本没带中止条件，跑飞了就是整机僵死。
4. ❌ **僵死时不要高频重试**（每秒 curl 一次那种）：雪上加霜，还会把现场证据冲掉。
   要探就用低频（2 分钟一次）。
5. ✅ **更新这台机器**：WS-only 入口走 `git pull` + `systemctl restart`（**不 build**）；
   需要构建产物就在本地构建好再传上去跑（§2）。
6. ✅ **僵死了只能从云控制台重启**（agent 做不到），而且**重启后要立刻取证**（§18.5）——
   证据会随时间被新的日志淹没。

### 18.5 重启后第一时间要取的证据（顺序别乱）

**为什么急**：内核环形缓冲区（`dmesg`）**重启即丢**；但 systemd journal 是**落盘**的、
跨重启保留 —— 上一段 boot 的日志就是现场。

> ✅ **这套清单 2026-11-27 真的用上了**，而且**是它把结论从「猜」变成「证」**：
> `journalctl --list-boots` 先定位「僵死发生在哪个 boot」，
> 再用 `-b -1` 把**上一个 boot 的尾巴**捞出来 —— 退化时间线、snapd 循环、
> 存档写盘失败、连关机都执行不了，全在里面。

```bash
# ① 先确认僵死发生在哪个 boot（这一步决定后面所有查询的范围）
journalctl --list-boots | tail -5
journalctl -b -1 --no-pager | tail -80          # 上一个 boot 的尾巴 = 死前现场

# ② OOM killer 杀的是谁（这次是**零条** —— 别因为「没查到」就默认「是内存问题」）
journalctl -b -1 -k --no-pager | grep -iE "out of memory|oom-kill|killed process" | tail -30

# ③ 退化时间线：某个单元是不是在反复重启/超时
journalctl -b -1 --no-pager | grep -E "Watchdog timeout|Scheduled restart job|start operation timed out" | tail -30

# ④ 本服务在死前干了什么
journalctl -b -1 -u lan-chess-ws --no-pager | tail -100

# ⑤ 现在的内存 / 磁盘 / 谁最占内存
free -m; df -h /; ps aux --sort=-%mem | head -15

# ⑥ 存档目录（存档写不进去时，第一眼就能看出来）
ls -la /opt/lan-chess/.data/; du -sh /opt/lan-chess/.data/*

# ⑦ 这台机器上一次是什么时候被人重启的（对照僵死窗口）
last -x reboot | head -10
```

### 18.6 加固：**压测相关的全部不做**（球球 2026-11-27 拍板）

> 球球的决定：**「我们这个小项目根本不需要压测。」**
> 于是下面 1、2 两条（都是为「扛住规模」设计的）**一并作废**，不再做：
>
> 1. ~~**连接数上限**（`MAX_CLIENTS` + nginx `limit_conn`）~~ —— 为了扛洪峰，现在不测也不需要扛。
> 2. ~~**把大厅广播从 O(n²) 降下来**~~ —— 同一个理由。
>
> 只剩一条还留着，因为它保护的是**这台机器上的另外 4 个站点**，不是我们的规模：
> 3. **给 systemd 单元加内存上限** ✅ **已做（2026-11-27）** —— `MemoryMax=700M`，
>    装在 `deploy/lan-chess-ws.service` 里。
>    **数值是实测推导的，不是拍脑袋**：空闲 67MB；开一局 AI 对局 594MB
>    （WASM 版 Stockfish 子进程占 472MB，且**玩完一局不释放**）。
>    所以~~256M~~会**把每一局 AI 对局都打死** —— 改成实测峰值 + 余量 = 700M。
>    想把上限压回 256M，得先装**原生** Stockfish（150~200MB，见 §7）。
>
> 4. ✅ **加极简监控**（2026-11-27 拍板要）—— `deploy/lan-chess-watchdog.sh`
>    + `lan-chess-watchdog.service` + `.timer`，**每 5 分钟**采一次
>    （可用内存 / swap / 负载 / 本服务 cgroup 内存 / 最占内存的三个进程 / 磁盘）
>    写进 journal。装法见 §18.9。

### 18.7 重启后已经做的处置（2026-11-27）

| 问题 | 处置 |
|---|---|
| **nginx 开不起来，5 个站点全下线** | 开机时 nginx 解析 `proxy_pass` 的上游（一个 GitHub Pages 域名）失败 → `[emerg] host not found in upstream` → **nginx 拒绝启动，5 个站点一起没**（这次重启后就是这样）。已加 systemd 兜底：`After/Wants=network-online.target` + `Restart=always` + `RestartSec=10`（解析不到就每 10 秒重试，而不是躺平） |
| **存档写盘竞态（46 小时存不进去）** | `src/server/store.ts`：原子写的临时文件名改成**每次唯一**（原来固定 `${file}.tmp`，并发写互相抢 → `rename` ENOENT），并且 **flush 串行化**（上一次没写完不开下一次）。配 `tests/store.test.ts`（并发 flush 不报错 / 存档完整 / 失败要看得见） |
| 服务器上的代码 | `git pull` 到最新（WS-only 入口**不 build**），`systemctl restart lan-chess-ws`，`/healthz` 返回 `{"ok":true,"mode":"ws-only"}` |
| 端到端 | 真浏览器：Vercel 页面 → WSS → nginx → WS 服务，走通「连上（在线 0）→ 输入用户名 → 进入大厅 → 看到大厅」 |

### 18.8 「是不是压测导致的」——**不是**，用 nginx 访问日志对出来了

僵死当天到底有没有连接洪峰，看 **chess 站点自己的访问日志**就一目了然
（`/var/log/nginx/lan-chess.access.log*`，站点配置里单独写的 `access_log`，
不在全局 `access.log` 里 —— 找错文件会以为「那天一条都没有」）：

| 日期 | /ws 连接数 | 形态 | 来源 |
|---|---|---|---|
| **11-23（真压测那天）** | **499** | **456 条挤在同一分钟** | 单一 IP（就是发起压测的那台机器） |
| 11-25 | 237 | 全天稳定 5~7 条/分钟 | 同上 IP（+ 另一条线路） |
| 11-26 | 685 | 全天稳定 5~7 条/分钟 | 同上 IP |
| **11-27（僵死当天）** | **6** | — | — |

**结论**：
1. **僵死当天只有 6 条连接** → 根本没有连接洪峰，**不是压测**（跟 §18.2「零条 OOM 记录」互相印证）。
2. 11-25/26 那几百条是**一个客户端的「掉线—重连」循环**：连接每 ~12 秒掉一次、
   客户端立刻重连（10 秒心跳超时 + 1.5 秒重试），全天不停。
   —— 这本身是**症状不是原因**：服务端事件循环已经跟不上，pong 发不出去，客户端才掉线。
3. **这个循环是我们自己的旧客户端造成的**（固定 1.5 秒重连、没有退避）。
   现在改成「10 秒连不上就判定失败 + 1.5s→30s 退避」后，
   同样的病态服务器上，客户端的重连频率会**大幅下降**（12 秒一轮 → 21 秒起、且逐轮拉长）。
4. 唯一一次真正的压测是 **11-23**（那次有 OOM 记录，是另一回事，见 §2）。
   **这条路的最终处置：不再压测**（球球 2026-11-27 拍板，§2、§17.11、§18.6）。

### 18.9 监控与内存上限（2026-11-27 装好）

**① 内存上限**：`deploy/lan-chess-ws.service` 里加了 `MemoryMax=700M`。
数值是**实测推导**的：

| 场景 | 本服务 cgroup 内存 |
|---|---|
| 空闲 | **67MB** |
| 开一局 AI 对局（引擎子进程在同一个 cgroup 里） | **594MB** ← WASM 版 Stockfish 占 472MB |
| 玩完那一局之后 | **582MB**（引擎常驻，**不还**） |

⚠️ **两个坑**：
1. `MemoryMax=256M`（我最初提的数字）**会打死每一局 AI 对局** —— 实测峰值 594MB。
   所以改成 700M（实测峰值 + 余量），仍然把本服务限制在整机（约 1586MB）的 44% 以内。
2. **玩一局 AI 对局，整机可用内存会从 725MB 掉到 264MB**（WASM Stockfish 的哈希吃 472MB，
   而且玩完还常驻）。要彻底解决得装**原生** Stockfish（150~200MB，见 §7），
   或者玩完 AI 局重启一下服务把引擎放掉。

**② 极简监控**（球球拍板要）：每 5 分钟采一次，写进 journal。

```bash
# 安装（脚本在仓库里，跟着 git pull 一起更新）
sudo cp /opt/lan-chess/deploy/lan-chess-watchdog.service /etc/systemd/system/
sudo cp /opt/lan-chess/deploy/lan-chess-watchdog.timer  /etc/systemd/system/
sudo chmod +x /opt/lan-chess/deploy/watchdog.sh
sudo systemctl daemon-reload
sudo systemctl enable --now lan-chess-watchdog.timer

# 看采样结果
journalctl -u lan-chess-watchdog.service -n 20 --no-pager
# 长一点的趋势（内存是不是一路涨上去的）
journalctl -u lan-chess-watchdog.service --since "-1 day" --no-pager | tail -50
```

采到的一行长这样：

```
[watch] mem_total=1586MB mem_avail=264MB swap_used=0MB/4095KB load=0.05/0.08/0.09 chess_ws=582MB top: node=472MB node=327MB node=99MB disk=38%
```

**它能回答的问题**（就是上次定不下来的那些）：
内存是不是一路涨上去的？某个进程是不是突然吃了一大块？
是不是 swap 被用满了？根分区是不是快满了？负载是不是有尖峰？




