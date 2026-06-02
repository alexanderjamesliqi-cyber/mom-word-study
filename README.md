# 妈妈叫我背单词

Python + Flask 后端的背单词网页系统，包含孩子端和家长端。

## 本地运行

```bash
python3 -m pip install -r requirements.txt
python3 server.py
```

访问：

- 孩子端：`http://127.0.0.1:5173/child/`
- 家长端：`http://127.0.0.1:5173/parent/`

## 数据

今日计划和孩子学习记录按日期保存在 `data/state-YYYY-MM-DD.json`。每天会按服务器时区 `Asia/Shanghai` 自动使用新的今日状态。

## 离线词典

项目支持把开源 ECDICT 英汉词典导入到本地 SQLite：

```bash
python3 import_dictionary.py
```

导入后后端会优先查询 `data/dictionary.db`。如果词条缺少例句，后端会生成一条简单儿童可读英文例句作为兜底。

ECDICT 来源：https://github.com/skywind3000/ECDICT

## 功能说明

- 家长端不直接跳转孩子端，只负责今日计划和检查验收。
- 今日计划通过一个输入框和 `+` 按钮添加单词。
- 输入英文或中文后，前端会调用 `/api/lookup` 在下方提示补全结果，确认后加入今日单词列表。
- 单词卡片可拖拽排序，移动端向右滑动可露出删除按钮。
- 孩子端不显示家长入口，顶部只保留任务进度条和今日单词列表，并适配手机竖屏、横屏。
- 检查验收支持选择日期查询历史记录，不提供清空今日记录入口。

## 生产运行示例

```bash
gunicorn -w 2 -b 0.0.0.0:888 server:app
```
