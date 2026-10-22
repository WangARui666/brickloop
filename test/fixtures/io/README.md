# IO 自建夹具

- `mod-01.mpd`：红黄各一件的 pair 定义，主模型引用两次；第二次旋转平移。展开四件，主模型和 pair 各有两个步骤；包含未知元命令以验证位置保留。
- `custom-cube.dat`：本项目编写的 20 LDU 立方体，用于验证 CustomParts 几何导出。没有复制外部零件几何。
- `out/`：由 `node scripts/devenv.mjs pnpm -F @brickloop/io fixtures` 生成，已有全仓 `out/` 忽略规则，不纳入 git。

Banana 外部样例只读测试由 `BRICKLOOP_STUDIO_BANANA` 配置，不存放在此目录。
