# `@building-energy/contracts`

Zod 是本包唯一的公共契约源。REST、SSE、Agent turn、通用 Skill lifecycle、
`BE_SKILL_EVENT` 与 artifact manifest 都从 `src/` 导出。

```bash
npm install
npm run generate
npm run verify
```

`generated/openapi.json` 和 `generated/api-types.ts` 是可审阅生成物。修改任一 Zod
schema 后必须运行 `npm run generate`；`npm run generate:check` 会在生成物漂移时失败。

`decodeSkillEventLine()` 只消费以 `BE_SKILL_EVENT ` 开头的 JSONL 行；普通日志返回
`null`。协议版本只接受当前声明的 `1.0`，同 major 的未知版本映射为
`UNSUPPORTED_PROTOCOL_VERSION`，不同 major 或格式错误映射为
`INCOMPATIBLE_PROTOCOL_VERSION`。
