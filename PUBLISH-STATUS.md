# 插件发布状态

## 当前状态：需要设置 2FA

npm 发布失败，错误信息：
```
npm error code E403
npm error 403 403 Forbidden - You may not perform that action with these credentials.
```

根据 npm 警告信息：
```
npm tokens that bypass 2FA are being restricted for account changes and direct publishing.
Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation
```

## 解决方案

需要为 npm 账户启用双因素认证（2FA），有两种方式：

### 方案 1：启用账户级 2FA（推荐）

1. 访问 https://www.npmjs.com/settings/ijry/profile
2. 点击 "Two-Factor Authentication"
3. 选择 "Authorization and Publishing"（发布时需要 2FA）
4. 使用手机上的认证器 App（如 Google Authenticator、Microsoft Authenticator）扫码
5. 输入验证码完成设置

### 方案 2：使用 Granular Access Token

1. 访问 https://www.npmjs.com/settings/ijry/tokens
2. 点击 "Generate New Token" → "Granular Access Token"
3. 配置权限：
   - Token name: `dsh-plugins-publish`
   - Expiration: 选择合适的时间
   - Packages and scopes: 选择 "Read and write"
   - IP ranges: 可选
4. 复制生成的 token
5. 本地设置：
   ```bash
   npm login --auth-type=web
   # 或手动编辑 ~/.npmrc
   # //registry.npmjs.org/:_authToken=YOUR_NEW_TOKEN
   ```

## 完成 2FA 设置后的发布步骤

```bash
# 1. 任务看板
cd plugins/dsh-plugin-taskboard
npm publish

# 2. 无限画布
cd ../dsh-plugin-canvas
npm publish

# 3. 手机遥控
cd ../dsh-plugin-mobile-bridge
npm publish

# 4. 仓库面板
cd ../dsh-plugin-repopanel
npm publish
```

## 验证发布

发布成功后验证：

```bash
npm info dsh-plugin-taskboard
npm info dsh-plugin-canvas
npm info dsh-plugin-mobile-bridge
npm info dsh-plugin-repopanel
```

## 当前准备情况

✅ 所有插件已构建（lib/ 目录已生成）
✅ 所有插件 README 已更新（包含暗黑模式说明）
✅ 创建了 PLUGINS.md 安装指南
✅ 创建了 PUBLISH.md 发布流程
✅ package.json 配置正确（version 0.1.0）
✅ 通过 npm publish --dry-run 验证
❌ 需要启用 npm 2FA

## 插件包信息

### dsh-plugin-taskboard
- Version: 0.1.0
- Size: 55.9 kB (packed), 262.7 kB (unpacked)
- Files: 20

### dsh-plugin-canvas
- Version: 0.1.0
- Status: 待发布

### dsh-plugin-mobile-bridge
- Version: 0.1.0
- Status: 待发布

### dsh-plugin-repopanel
- Version: 0.1.0
- Status: 待发布

## 下一步

1. **立即**：设置 npm 2FA（推荐方案 1）
2. **然后**：重新运行上述四条 `npm publish` 命令
3. **最后**：提交到 awesome-dsh-plugin registry

发布成功后，删除本文件或更新为发布记录。
