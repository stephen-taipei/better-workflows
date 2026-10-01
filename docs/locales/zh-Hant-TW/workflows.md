<!-- Generated from docs/guide/workflows.md; source-sha256: 2acaf671415fc972265bcc5c4f20484c1a6cbea2dd1e6aa3fb22f54943786bb0; edit docs/rc1-catalogs/workflows/*.json. -->
# 工作流程

[English](../en/workflows.md) · **繁體中文（台灣）**

| [總覽](../../../README.md) | [詳細說明](../../../docs/details/en.md) | [快速開始](getting-started.md) | **工作流程** | [架構](architecture.md) | [安全性](security-guide.md) | [CLI](cli-reference.md) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |

## Auto

```text
$better-workflows:auto <describe the outcome you need>
```

## 常見路徑

```mermaid
flowchart TD
  A{"希望達成什麼成果？"}
  A -->|"只做審查"| B["auto"]
  A -->|"修復並交付"| C["auto"]
  A -->|"比較方案"| D["auto"]
  A -->|"發布或不可逆操作"| E["HOLD"]
  A -->|"重複執行穩定的操作步驟"| F["auto"]
  A -->|"不確定"| G["HOLD"]
```
