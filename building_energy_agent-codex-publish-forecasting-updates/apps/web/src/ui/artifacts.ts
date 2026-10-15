export function artifactDisplayName(artifactType: string): string {
  if (/building-energy\.report|report-generation/i.test(artifactType)) return '建筑能源专业分析报告';
  if (/dataset|parsing|parse/i.test(artifactType)) return '建筑能源数据解析结果';
  if (/processing|process/i.test(artifactType)) return '建筑能源预测数据处理结果';
  if (/quality|assessment/i.test(artifactType)) return '数据质量评估结果';
  if (/forecast|evaluation|model/i.test(artifactType)) return '建筑能源负荷预测结果';
  if (/visual/i.test(artifactType)) return '可视化证据';
  return '分析结果文件';
}

export function fileRoleDisplayName(role: string): string {
  const labels: Record<string, string> = {
    visualization: '图表',
    chart: '图表',
    plot: '图表',
    figure: '图表',
    'forecast-chart': '预测图表',
    'forecast-preview': '预测序列',
    forecast_preview: '预测序列',
    'forecast-data': '预测数据',
    forecast_data: '预测数据',
    'quality-data': '质量数据',
    quality_data: '质量数据',
    data: '数据证据',
    evidence: '数据证据',
    report: '报告',
    manifest: '结果清单',
  };
  return labels[role.toLowerCase()] ?? '结果文件';
}

export function controlledContentUrl(value: string): string | null {
  const url = value.trim();
  return /^\/api\/v1\/artifacts\/[^/?#]+\/content\?file=\d+$/.test(url) ? url : null;
}
