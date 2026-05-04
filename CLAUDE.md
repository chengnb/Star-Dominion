# 星域争霸 · Star Dominion — AI 开发文档

## 项目概述

多人实时太空策略网页游戏。权威服务器架构 — 所有游戏逻辑在 Node.js 服务端执行，浏览器端纯 Canvas 渲染 + 输入转发。

- **账号系统**: 注册/登录，bcrypt + JWT，进度持久化到 PostgreSQL
- **世界**: 区块式无限世界（类似 Minecraft），惰性加载，种子化确定生成
- **技术栈**: Node.js + Express + Socket.IO + HTML5 Canvas + PostgreSQL

---

## 项目结构

```
Y:\game\
├── CLAUDE.md                    # 本文件 — AI 开发文档
├── README.md                    # 面向玩家的说明文档
├── server/                      # 后端 — 权威游戏服务器
│   ├── package.json             # 依赖: express, socket.io, bcryptjs, jsonwebtoken, pg
│   ├── index.js                 # 入口: Express + Socket.IO + 异步游戏主循环
│   ├── db.js                    # PostgreSQL 数据库 (PgDatabase 类)
│   └── game/
│       ├── constants.js         # 游戏常量 (区块/行星/飞船/战斗参数)
│       ├── SpatialGrid.js       # 空间分区网格 (Map 实现，无限坐标)
│       └── GameWorld.js         # 游戏核心 — 区块生成/战斗/持久化/通知
├── client/                      # 前端 — 无框架，原生 JS + Canvas
│   ├── index.html               # 单页面: 登录界面 + 游戏画布 + UI 面板
│   ├── css/style.css            # 全部样式 (含系统消息/退出按钮)
│   └── js/
│       ├── main.js              # 连接管理 & 认证 (注册/登录/退出/Token)
│       └── Game.js              # 渲染引擎 / 镜头 / 输入 / HUD / 小地图
└── data/
    └── gamedata.json            # 已弃用 — 数据迁移至 PostgreSQL
```

---

## 架构关键决策

### 1. 权威服务器 (Authoritative Server)
客户端仅是"摄像机 + 输入设备"，不执行任何游戏逻辑。所有操作通过 `game:command` 事件发送，服务端计算后通过 `game:update` 推送状态。

### 2. 区块式无限世界
世界按 2000×2000 单位划分区块 (chunk)。使用 `mulberry32` 种子化 PRNG，以区块坐标 (cx, cy) 作为种子确定生成行星位置。区块在玩家视口接近时惰性生成并写入 PostgreSQL。每区块目标 ~10 颗行星。

**关键类/方法**:
- `GameWorld._generateChunk(cx, cy)` — 生成单区块，种子 `(cx * 0x9E3779B9 + cy * 0x7F4A7C13) >>> 0`
- `GameWorld._loadVisibleChunks()` — 每 tick 检查，预加载范围 `VIEW_RADIUS + CHUNK_SIZE`
- `GameWorld.loadedChunks` — Set，跟踪已加载区块
- `GameWorld._isNearExistingPlanet()` — 跨区块最小距离检查

### 3. 双重脏标记系统 (重要!)
行星变更时通过 `_markPlanetDirty(id)` 同时写入两个集合：
- **`dirtyPlanets`**: 每 tick 由 `clearDirtyPlanets()` 清空，用于网络同步——脏行星无视视口广播
- **`_pendingSave`**: 仅在数据库保存成功后由 `world._pendingSave.clear()` 清空，用于持久化

这是关键的纠错点。之前只有 `dirtyPlanets`，导致每个 tick 后数据丢失无法入库。

### 4. 离线玩家行星保留
玩家断线时 `removePlayer()` 只清除 `planet.ownerId`（socket 关联），保留 `ownerUserId`、`ownerUsername`、`defenseLevel`、`garrison`。重连时 `restoreOwnership()` 扫描全部行星恢复所有权。

**行星所有权判断** (在 `_checkArrivals`):
- `ownerId === fleet.ownerId` → 己方，合并驻军
- `!ownerId && !ownerUserId` → 真正中立，直接占领
- 其他情况 → 敌方或离线玩家，需要战斗

### 5. 用户缓存 (userCache)
`GameWorld.userCache`: `Map<userId, {username, color}>` — 启动时从 users 表加载，新玩家加入时追加。颜色由 `userId % palette.length` 决定，保证一致性。用于离线玩家行星显示。

### 6. 状态同步策略
- **首次连接**: `game:init` 发送全量状态 (行星/舰队/在线玩家/ownerCache)
- **每 tick**: `game:update` 发送视口内实体 + 脏行星，`volatile.emit`
- **行星数据包含**: ownerId, ownerUserId, ownerUsername, defenseLevel, garrison (全量，不限己方)
- **舰队数据包含**: ownerUsername, fromPlanetName, toPlanetName, ships
- **排行榜**: 每 20 ticks 广播，按 `ownerUserId` 聚合 (含离线玩家)

### 7. 事件委托 (客户端)
行星面板的建造按钮使用事件委托挂在 `#panel-actions` 上，不在每个 tick 重新绑定。面板选中行星变化时完整重建(`_updatePlanetPanel`)，每 tick 仅刷新文本和按钮状态(`_refreshPlanetPanel`)。

### 8. 持久化方案
PostgreSQL (`localhost:5432`, 密码 `Aa123456`, 数据库 `star_dominion`)。服务器启动时自动创建数据库和表。每 30 秒批量保存行星状态和玩家资源。断线时立即保存玩家资源。

**表结构**:
- `users` (id, username, password_hash, created_at)
- `planets` (id, chunk_x, chunk_y, world_x, world_y, type, name, owner_user_id, defense_level, is_home, garrison_scout/fighter/battleship)
- `player_state` (user_id PK, minerals, energy, tech_level, home_planet_id)

---

## 已实现功能

| 功能 | 位置 |
|------|------|
| 注册/登录 (bcrypt + JWT) | `server/index.js`, `server/db.js` |
| 退出登录 | `server/index.js` (auth:logout), `client/js/main.js` |
| Token 自动登录 | `client/js/main.js` (localStorage) |
| 区块式无限世界生成 | `server/game/GameWorld.js:_generateChunk` |
| 行星唯一编号名称 (行星-N) | `server/db.js:insertPlanets` |
| 三种行星类型 | `server/game/constants.js` |
| 资源生成 (按行星类型) | `server/game/GameWorld.js:_generateResources` |
| 建造飞船 | `server/game/GameWorld.js:_handleBuildShip` |
| 派遣舰队 (全部驻军) | `server/game/GameWorld.js:_handleSendFleet` |
| 舰队航行 + 速度计算 | `server/game/GameWorld.js:_moveFleets` |
| 中立行星占领 | `server/game/GameWorld.js:_checkArrivals` |
| 敌行星战斗 (含离线玩家) | `server/game/GameWorld.js:_battleAtPlanet` |
| 舰队间遭遇战 | `server/game/GameWorld.js:_resolveCombat` |
| 行星防御升级 | `server/game/GameWorld.js:_handleUpgradeDefense` |
| 排行榜 (含离线玩家) | `server/game/GameWorld.js:getLeaderboard` |
| 舰队到达/占领系统通知 | `server/game/GameWorld.js:_addSystemMessage` |
| 聊天系统 | `server/index.js`, `client/js/Game.js` |
| 离线行星归属显示 | `userCache` + `_getOwnerInfo` |
| 驻军全局可见 | `getVisibleState` 发送所有行星 garrison |
| 舰队航线虚线 + 悬浮提示 | `client/js/Game.js:_drawFleet` |
| 行星悬浮提示 (名称/拥有者/防御/驻军) | `client/js/Game.js` render hover |
| 母星重分配 (全行星丢失时) | `server/game/GameWorld.js:addPlayer` |
| 视口裁剪 | `SpatialGrid.query()` + `getVisibleState` |
| 区块边界虚线 + 坐标标签 | `client/js/Game.js:_drawGrid` |
| 动态小地图 (以镜头为中心) | `client/js/Game.js:_drawMinimap` |
| Canvas 渲染 (星空/行星/舰队) | `client/js/Game.js` |
| 镜头控制 (拖拽/滚轮/H 回母星) | `client/js/Game.js:_bindEvents` |
| 行星信息面板 + 离线标签 | `client/js/Game.js:_updatePlanetPanel` |
| 资源不足按钮自动禁用 | `client/js/Game.js:_refreshPlanetPanel` |
| 服务器优雅关闭 + 断线保存 | `server/index.js` (SIGINT/SIGTERM/disconnect) |

---

## 待实现功能

- [ ] **部分派遣**: 当前右键发送全部驻军，无法选择数量
- [ ] **音效/音乐**: 暂无音频
- [ ] **战斗动画**: 战斗静默结算，无视觉反馈
- [ ] **科技树**: techLevel 字段已预留但未使用
- [ ] **移动端适配**: 仅桌面端 Canvas 交互，无触屏支持
- [ ] **联盟/外交**: 纯 PvP，无联盟系统
- [ ] **部分派遣面板**: 类似建造面板，可选择派遣数量

---

## 开发指南

### 启动服务
```powershell
cd Y:\game\server
node index.js
# 运行在 http://localhost:3000
# 需要 PostgreSQL 运行中，密码 Aa123456
```

### 关键文件修改指南

| 要改什么 | 改哪里 |
|----------|--------|
| 游戏平衡 (飞船/防御参数) | `server/game/constants.js` |
| 区块参数 (尺寸/密度) | `constants.js` CHUNK_SIZE / PLANETS_PER_CHUNK |
| 新增飞船类型 | `constants.js` SHIP_TYPES；`GameWorld.js` switch 分支 |
| 新增行星类型 | `constants.js` PLANET_TYPES；客户端 `Game.js` PLANET_TYPES |
| 新增玩家命令 | `server/index.js` socket.on；`GameWorld.js` `_handle*` + `_processCommands` |
| 修改 UI/渲染 | `client/js/Game.js`；CSS `client/css/style.css` |
| 修改认证流程 | `server/index.js` socket 事件；`client/js/main.js` |
| 修改数据库/持久化 | `server/db.js` |

### 数据流

```
浏览器操作 → socket.emit('game:command', cmd)
  → server/index.js: socket.on('game:command')
    → world.enqueueCommand(socketId, cmd)
      → [下一 tick] world._processCommands()
        → world._handleXxx(cmd)  // 修改状态，_markPlanetDirty(id)
          → [同一 tick] world.getVisibleState(socketId)
            → socket.volatile.emit('game:update', state)
              → 客户端 Game.onUpdate(data) → 更新 planets/fleets Map → 渲染
```

### 区块加载流

```
玩家移动 → set_view 命令 → player.viewX/Y 更新
  → [每 tick] _loadVisibleChunks()
    → 遍历视口覆盖的区块坐标
    → 未加载区块 → _generateChunk(cx, cy)
      → 种子 PRNG 生成候选位置
      → 跨区块最小距离检查 _isNearExistingPlanet()
      → 批量 INSERT PostgreSQL → 获取 ID
      → 行星名称 UPDATE "行星-{id}"
      → 加入 planets Map + spatialGrid
```

### 持久化流

```
行星变更 → _markPlanetDirty(id)
  → dirtyPlanets.add(id)   ← 每 tick 清空
  → _pendingSave.add(id)   ← 仅保存后清空
  
每 30 秒 → toSaveData() → 读取 _pendingSave
  → db.savePlanetsBatch() → PostgreSQL UPDATE
  → db.savePlayerStates() → PostgreSQL UPSERT
  → _pendingSave.clear()

断线 → disconnect 事件 → 立即保存玩家资源
  → removePlayer() → 仅清除 ownerId，保留 ownerUserId
```

### 客户端渲染帧

```
requestAnimationFrame 循环:
  1. 平滑缩放 (指数衰减)
  2. 绘制星空背景 (视差滚动)
  3. 绘制网格 + 区块边界虚线 + 区块坐标标签
  4. 绘制己方行星连线
  5. 绘制视口内行星 (渐变球体 + 拥有者光环 + 防御标记 + 名称标签)
  6. 绘制舰队航线虚线 + 舰队 (三角箭头 + 数量标签)
  7. 绘制选中行星指示器 (虚线脉冲光环)
  8. 悬浮提示框 (行星详情 或 舰队详情)
  9. HUD 独立 DOM 层
  10. 小地图 (以镜头为中心的动态范围)
```

### 常见陷阱

1. **双重脏标记**: 保存用 `_pendingSave`，网络用 `dirtyPlanets`，不要混用。
2. **不在每 tick 修改 DOM innerHTML**: 用 textContent 更新文本，用 disabled/classList 改按钮状态。
3. **Socket.IO volatile**: 高频状态同步用 volatile，一次性事件 (命令响应、系统消息) 不用。
4. **离线行星所有权**: `_checkArrivals` 用 `!ownerId && !ownerUserId` 判断真正中立，不是仅检查 `ownerId`。
5. **removePlayer**: 只清除 socket 关联，不清除 `ownerUserId`/防守/驻军，否则数据刷新即丢失。
6. **区块生成**: `loadedChunks.add(key)` 必须在行星写入内存后调用，避免竞态导致空区块永久跳过。
7. **客户端 `_getOwnerInfo`**: 优先在线玩家 → ownerCache (离线) → 行星存储的 username 兜底。

---

## 游戏数值速查

| 参数 | 值 |
|------|-----|
| 区块尺寸 | 2000 × 2000 |
| 每区块行星数 | ~10 |
| 行星最小间距 | 150 |
| 视口半径 | 800 |
| 区块预加载范围 | 2800 (VIEW_RADIUS + CHUNK_SIZE) |
| Tick 速率 | 20 TPS (50ms) |
| 保存间隔 | 30 秒 |
| 初始资源 | 500 矿物 / 500 能量 |
| 初始舰队 | 3 侦察机 + 2 战斗机 |

| 飞船 | 造价 | 速度(单位/秒) | HP | 伤害 |
|------|------|-------------|-----|------|
| 侦察机 | 50矿/30能 | 180 | 30 | 5 |
| 战斗机 | 100矿/50能 | 130 | 80 | 15 |
| 战列舰 | 250矿/150能 | 80 | 250 | 40 |

| 行星类型 | 矿物/秒 | 能量/秒 |
|----------|---------|---------|
| 岩石行星 | 3 | 1 |
| 类地行星 | 2 | 2 |
| 气态巨行星 | 1 | 3 |

| 防御 | 每级 HP | 每级伤害 | 升级成本 |
|------|---------|---------|---------|
| 防御工事 | 100 | 20 | 200矿/100能 |
