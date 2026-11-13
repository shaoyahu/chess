# 部署到云服务器（VPS）

> 面向「自己的云服务器 / VPS」这套环境。容器平台（Fly / Railway / ECS）也适用本文，
> 只是把 systemd 那节换成容器里的进程管理。
>
> **Serverless（Vercel / Netlify）不适用** —— 原因见文末「已知限制」。

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
