# 从外网连：内网穿透教程

局域网里扫码就能用，不需要这一篇。**只有在外面（4G/公司网/别人家 Wi-Fi）也想连**的时候才需要把桥暴露出去。

先说三句结论：

1. **只暴露手机桥的端口（默认 8790），永远不要暴露 dsh 自己的端口。** dsh 界面上没有任何认证，拿到那个地址等于拿到这台机器的 shell。手机桥的每个有状态请求都要 Bearer token。
2. **让隧道终结 TLS。** 桥自己不做 TLS；下面几种方案给的都是 `https://` 入口。
3. **暴露之后先把配对码换一次**（面板上「换一个配对码」），再用新码配对。旧码是在只有局域网能访问的时候生成的。

下面按「最省事」到「最可控」排列，选一个就行。

---

## 方案 A：Cloudflare 快速隧道（最省事，不用域名不用账号）

适合：临时用、出门前临时开一下。缺点是每次重启地址都变。

**1. 装 `cloudflared`**

```bash
# macOS
brew install cloudflared

# Windows（任选其一）
winget install --id Cloudflare.cloudflared
scoop install cloudflared

# Linux（Debian/Ubuntu）
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
```

**2. 起隧道，指向桥的端口**

```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

输出里会有一行：

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:                                          |
|  https://random-words-here.trycloudflare.com                                               |
+--------------------------------------------------------------------------------------------+
```

**3. 验证一下再配对**

```bash
curl https://random-words-here.trycloudflare.com/dsh-mobile-bridge/hello
```

应该返回 `{"ok":true,"value":{...,"targetAgent":"dsh",...}}`。返回 502 说明桥没起来（看 dsh 的日志）；返回 404 说明路径少了 `/dsh-mobile-bridge`。

**4. 在 App 里填地址**

在 MCode 里新增连接（或编辑已有连接），服务地址填：

```
https://random-words-here.trycloudflare.com/dsh-mobile-bridge
```

然后用面板上的配对码 + 密钥配对。扫码得到的二维码里是**局域网地址**，所以走隧道时要手工改地址 —— 或者更简单：**先在局域网里扫码配对好，出门后只改地址**，令牌不用重新拿。

**注意**

- `--url` 后面必须是 `127.0.0.1:8790`，不是 dsh 的端口。填错了就是把无认证界面挂到公网。
- 快速隧道没有 SLA，Cloudflare 随时可能收；长期用请看方案 B。
- 终端关掉隧道就断，地址作废。这既是缺点也是安全特性。

---

## 方案 B：Cloudflare 命名隧道（固定域名，长期用）

适合：经常要在外面连。地址固定，可以开机自启。

需要一个托管在 Cloudflare 的域名（免费计划够用）。

```bash
# 1. 登录（浏览器授权一次）
cloudflared tunnel login

# 2. 创建隧道，名字随便
cloudflared tunnel create dsh-mobile

# 3. 把子域名指到这条隧道
cloudflared tunnel route dns dsh-mobile dsh.example.com
```

**4. 写配置文件**

`~/.cloudflared/config.yml`（Windows 是 `%USERPROFILE%\.cloudflared\config.yml`）：

```yaml
tunnel: dsh-mobile
credentials-file: /Users/you/.cloudflared/<隧道UUID>.json

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:8790
  - service: http_status:404
```

最后那条 `http_status:404` 别删：没有它，任何没匹配上的 hostname 都会落到第一条规则上。

**5. 跑起来 / 装成服务**

```bash
cloudflared tunnel run dsh-mobile

# 开机自启
sudo cloudflared service install     # macOS / Linux
cloudflared service install          # Windows（管理员 PowerShell）
```

App 里的服务地址：`https://dsh.example.com/dsh-mobile-bridge`

**建议再加一层 Cloudflare Access。** 隧道本身只是把端口搬到公网，认证还是桥的 token。想再收紧就在 Zero Trust 里给 `dsh.example.com` 加一条 Access 策略（邮箱 OTP 就够）。代价：手机 App 不会走 Access 的浏览器登录流程，所以要么给 App 的路径开 bypass、要么用 Service Token（`CF-Access-Client-Id` / `CF-Access-Client-Secret` 两个头）—— 当前版本的 MCode 还不能自定义请求头，所以实践上是**对 `/dsh-mobile-bridge/*` 开 bypass，其余路径要求登录**。

---

## 方案 C：Tailscale（不开公网端口，最稳）

适合：只想自己的几台设备互通，不想有任何东西暴露在公网。

```bash
# 电脑和手机都装 Tailscale 并登录同一个账号
tailscale up
tailscale ip -4      # 拿到 100.x.y.z
```

App 里的服务地址：`http://100.x.y.z:8790/dsh-mobile-bridge`

这时候手机桥的监听地址不用变（还是 `0.0.0.0`），流量走 WireGuard，公网上没有任何监听端口。**这是本文里安全性最好的方案**，代价是手机上要装并登录 Tailscale。

想要 TLS 的话：`tailscale serve https / http://127.0.0.1:8790`，会给一个 `https://<机器名>.<tailnet>.ts.net` 的地址。

---

## 方案 D：自己的反向代理（已有服务器时）

已经有一台带域名和证书的机器时，最省心的是让它反代。

Caddy：

```caddyfile
dsh.example.com {
    reverse_proxy 127.0.0.1:8790 {
        flush_interval -1     # SSE 必需：不要缓冲事件流
    }
}
```

Nginx：

```nginx
location /dsh-mobile-bridge/ {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # SSE 必需
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;

    client_max_body_size 16m;   # 手机发图片
}
```

`proxy_buffering off` / `flush_interval -1` 不是可选项：开着缓冲的话流式回复会一口气堆到回合结束才吐出来，看起来就像卡死。桥自己每 20 秒发一次心跳注释行，所以 `proxy_read_timeout` 只要大于 20 秒就不会误断。

---

## 出问题怎么查

| 现象 | 大概率原因 |
| --- | --- |
| `curl .../hello` 返回 502 / 连接被拒 | 桥没监听。看 dsh 日志里有没有 `手机桥已监听`；端口被占时面板上会显示错误 |
| 返回 404 | 地址少了 `/dsh-mobile-bridge` |
| 配对返回 401 | 码过期了、或已经被用掉了。面板上「换一个配对码」再来 |
| 能登进去但消息不流式，一次性全出来 | 反代在缓冲。见方案 D 的 `proxy_buffering off` |
| 连一会儿就断 | 反代或隧道的读超时短于 20 秒的心跳间隔 |
| 局域网能连、外网不能 | 隧道指到了 dsh 的端口而不是 8790，或者 hostname 落到了兜底规则上 |

诊断命令：

```bash
# 桥自己活着吗（在跑 dsh 的那台机器上）
curl -s http://127.0.0.1:8790/dsh-mobile-bridge/hello | head -c 300

# 局域网通吗（在手机所在网络的另一台机器上）
curl -s http://<电脑局域网IP>:8790/dsh-mobile-bridge/hello | head -c 300

# 隧道通吗
curl -s https://<你的隧道域名>/dsh-mobile-bridge/hello | head -c 300
```

三条依次跑，第一条不通就是插件的事，第二条不通看防火墙（Windows 首次监听会弹窗问是否允许），第三条不通是隧道配置。

## 不用了怎么收干净

1. 停掉隧道（`Ctrl-C`，或 `cloudflared service uninstall`）。
2. dsh 面板 →「全部解除并换码」。手机上的令牌立刻失效。
3. 不想再监听局域网的话，profile 的 `cordis.patch.yml` 里给这个插件加 `config: { lan: false }`，重启 dsh 服务。面板还在，只有本机能用。
