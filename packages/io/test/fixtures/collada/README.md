# COLLADA 1.4.1 schema 测试

测试读取工作树 `.devdata/io-schema/collada_schema_1_4_1.xsd` 和 `xml.xsd`，不联网。下载命令：

```powershell
node scripts/devenv.mjs pnpm --filter @brickloop/io schema:fetch
```

来源为 Khronos 官方 GitHub 组织维护的 [OpenCOLLADA schema](https://github.com/KhronosGroup/OpenCOLLADA/blob/6031fa956e1da4bbdd910af3a8f9e924ef0fca7a/DAEValidator/xsd/collada_schema_1_4_1.xsd)，固定 commit `6031fa956e1da4bbdd910af3a8f9e924ef0fca7a`；其 XML 命名空间依赖为 [W3C xml.xsd](https://www.w3.org/2001/03/xml.xsd)。下载脚本记录来源与 SHA-256，不修改 schema。

COLLADA XSD 的头部声明 `Copyright (C) 2005, 2006 The Khronos Group Inc., Sony Computer Entertainment Inc. All Rights Reserved.`，附有免责条款，但该文件没有明确给出宽松再分发授权。本任务不把仓库中其他组件的许可自动套用于它；按主窗口补充授权，只下载到被忽略的 `.devdata/` 作本地校验，不将 XSD 内容纳入提交。W3C 文件也保留在同一个本地目录。

缺少任一文件时，仅 XSD 用例跳过，测试名称给出缺失原因和下载命令。其余 XML 解析、实例结构、单位、材质、名称转义和 GLB 校验仍必须执行。取得 schema 后，XSD 用例同时校验有效导出，并确认错误版本、非法元素和缺少必填字段会被拒绝，避免无效的“通过”。libxml2 的外部引用只由测试中的内存 provider 提供，无网络或文件系统回退。
