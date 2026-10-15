export type TaskPresetId = 'forecast' | 'quality' | 'integrated';

export interface TaskPreset {
  id: TaskPresetId;
  title: string;
  description: string;
  prompt: string;
}

const taskPresetMap: Record<TaskPresetId, TaskPreset> = {
  forecast: {
    id: 'forecast',
    title: '负荷预测',
    description: '处理数据并预测未来 24 小时负荷',
    prompt: '请处理已上传的建筑能源数据，并预测目标点位未来 24 小时负荷。',
  },
  quality: {
    id: 'quality',
    title: '数据质量评估',
    description: '检查缺口、异常与六维质量风险',
    prompt: '请检查已上传建筑能源数据的缺口、异常和质量风险，并给出质量结论。',
  },
  integrated: {
    id: 'integrated',
    title: '质量评估 + 负荷预测',
    description: '并行完成质量评估与负荷预测',
    prompt: '请对已上传建筑能源数据进行质量评估和负荷预测，并行完成两项分析。',
  },
};

export const taskPresets = [
  taskPresetMap.forecast,
  taskPresetMap.quality,
  taskPresetMap.integrated,
];

export function getTaskPreset(id: TaskPresetId): TaskPreset {
  return taskPresetMap[id];
}
