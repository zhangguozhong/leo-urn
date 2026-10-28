/** 容器错误与业务 Bridge 的协议错误分别保留，便于定位接入问题。 */
export class URNError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'URNError';
  }
}
