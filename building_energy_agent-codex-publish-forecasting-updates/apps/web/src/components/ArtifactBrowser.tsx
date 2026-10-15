import { Download, File, Image as ImageIcon, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Artifact } from '../domain';
import { artifactDisplayName, controlledContentUrl, fileRoleDisplayName } from '../ui/artifacts';
import { formatBytes, shortHash } from '../ui/format';

function fileIcon(mediaType: string) {
  return mediaType.startsWith('image/') ? <ImageIcon size={16} /> : <File size={16} />;
}

function visibleFileName(name: string): string {
  return name.split(/[\\/]/).at(-1) ?? name;
}

export function ArtifactBrowser({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <section className="artifact-browser detail-section" aria-labelledby="artifact-title">
      <header>
        <div>
          <h2 id="artifact-title">结果文件</h2>
          <p>下载前由服务端核对归属、大小与 SHA-256。</p>
        </div>
        <span>{artifacts.reduce((sum, artifact) => sum + artifact.files.length, 0)} 个文件</span>
      </header>
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <section key={artifact.id} className="artifact-group">
            <div className="artifact-group-head">
              <span>
                {artifact.status === 'integrity_failed' ? (
                  <TriangleAlert size={15} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={15} aria-hidden="true" />
                )}
                {artifactDisplayName(artifact.artifactType)}
              </span>
              <small>
                {artifact.status === 'succeeded'
                  ? '已校验'
                  : artifact.status === 'partial'
                    ? '部分完成'
                    : '完整性失败'}
              </small>
            </div>
            {artifact.warnings.length > 0 && (
              <ul className="artifact-warnings">
                {artifact.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            <ul>
              {artifact.files.map((file) => (
                <li key={file.id}>
                  <span className="file-kind" aria-hidden="true">
                    {fileIcon(file.mediaType)}
                  </span>
                  <span className="file-identity">
                    <strong>{visibleFileName(file.name)}</strong>
                    <small>
                      {fileRoleDisplayName(file.role)} · {formatBytes(file.sizeBytes)}
                    </small>
                  </span>
                  {artifact.status === 'integrity_failed' ? (
                    <span className="integrity-error">完整性失败</span>
                  ) : controlledContentUrl(file.contentUrl) ? (
                    <a
                      className="icon-button"
                      href={controlledContentUrl(file.contentUrl) ?? undefined}
                      download={visibleFileName(file.name)}
                      aria-label={`下载 ${visibleFileName(file.name)}`}
                      title={`下载 ${visibleFileName(file.name)}`}
                    >
                      <Download size={16} />
                    </a>
                  ) : (
                    <span className="integrity-error">文件地址不可用</span>
                  )}
                </li>
              ))}
            </ul>
            <details className="artifact-technical">
              <summary>技术详情</summary>
              <dl>
                <div>
                  <dt>结果类型</dt>
                  <dd>{artifactDisplayName(artifact.artifactType)}</dd>
                </div>
                <div>
                  <dt>结果状态</dt>
                  <dd>{artifact.status === 'succeeded' ? '已校验' : artifact.status === 'partial' ? '部分完成' : '完整性失败'}</dd>
                </div>
                <div>
                  <dt>文件校验</dt>
                  <dd>
                    {artifact.files.length > 0
                      ? artifact.files.map((file) => (
                          <span key={file.id}>
                            {visibleFileName(file.name)}:{' '}
                            <code title={file.sha256}>{shortHash(file.sha256)}</code>{' '}
                          </span>
                        ))
                      : '—'}
                  </dd>
                </div>
              </dl>
            </details>
          </section>
        ))}
      </div>
    </section>
  );
}
