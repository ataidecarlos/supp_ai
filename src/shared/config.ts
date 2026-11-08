export interface Config {
  chatSide: 'left' | 'right';
  filesSide: 'left' | 'right';
  filesHidden: boolean;
}

export const DEFAULT_CONFIG: Config = { chatSide: 'left', filesSide: 'right', filesHidden: false };
