export const WINDOW_CONTEXT = {
  get is_dev() {
    return import.meta.env.DEV;
  }
};