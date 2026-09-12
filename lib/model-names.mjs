// Names only: unknown IDs and user-authored labels keep their provider spelling.
// This self-contained function is embedded in the pinned native metadata seam.
export function coldxModelDisplayName(model) {
  const known = [
    {
      "id": "deepseek-flash",
      "name": "DeepSeek-V4.1-Flash",
      "legacy": "DeepSeek V4.1 Flash · Vision"
    },
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek-V4-Flash",
      "legacy": "DeepSeek Flash · 兼容名称"
    },
    {
      "id": "deepseek-v4-flash-vision-exp",
      "name": "DeepSeek-V4-Flash-Vision-Exp",
      "legacy": "DeepSeek Flash · Vision 兼容名称"
    },
    {
      "id": "deepseek-v4-pro",
      "name": "DeepSeek-V4-Pro",
      "legacy": "DeepSeek V4 Pro"
    }
  ];
  const entry = known.find(item => item.id === model.id);
  if (!entry) return model.name ?? model.id;
  return model.name == null || model.name === model.id || model.name === entry.legacy
    ? entry.name : model.name;
}
