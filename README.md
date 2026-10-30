# 🎨 · DrawGen

第三方生图扩展。

## 1.8.11 内存问题修复

- 移除自动图片下载、上传到酒馆、旧图补存和入库 JPEG 转换。没有新增浏览器缓存。
- API 外链直接显示，聊天仅存链接；外链失效后需自行保存的原图或站点恢复。
- API 只返回 Base64 时只打开临时预览和手动下载入口，不写入聊天。下载或关闭后才能继续生成，避免结果互相覆盖。
- 聊天保存串行执行；各回复只保存自身图库快照。发现过大的旧内嵌图片时暂停插件保存和生图，不删除原记录。
- 原有本地文件仍可显示，已有存图天数不变；7 天清理继续针对以前保存的本地文件。

## 已有大聊天的离线修复

先停止 SillyTavern。以下脚本只使用 Node 内置模块，手动执行，不会被插件加载。

在本插件目录先检查（不改文件）：

```bash
node --max-old-space-size=64 scripts/repair-inline-images.cjs --root "$HOME/SillyTavern"
```

执行修复：

```bash
node --max-old-space-size=64 scripts/repair-inline-images.cjs --root "$HOME/SillyTavern" --apply
```

脚本逐段读取活动聊天与群聊，跳过酒馆备份，只把插件 `sdg_gal`、`sdg_images`、`sdg_image` 中的内嵌图片提取成独立文件；聊天文字、回复历史和其他插件内容保持不变。每份原聊天先备份并核对哈希，图片和新 JSONL 验证通过后才替换原文件。畸形输入、写入失败或检测到原文件发生变化时不替换。

原文件备份在 `SillyTavern/drawgen-repair-backup-日期/`，图片在对应用户的 `data/<user>/user/images/DrawGenRecovered/`。恢复图片的保留天数从修复日期开始算。备份会保留原来的大文件，不会自动删除；它们不在酒馆的活动聊天目录中。

需要撤销时，先关闭酒馆，把备份目录内对应的聊天文件复制回原相对路径。看到 `failed` 大于 0 时保留输出，不要删除聊天；更新插件本身也不会自动缩小已有大文件。

