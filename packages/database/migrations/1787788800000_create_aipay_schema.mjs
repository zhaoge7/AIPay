export const up = (pgm) => {
  pgm.createSchema('aipay', { ifNotExists: true });
};

export const down = (pgm) => {
  pgm.dropSchema('aipay', { ifExists: true });
};
