export function shouldShowBlockingLoader({
  loading,
  hasContent,
  error = false,
}) {
  return Boolean(loading && !hasContent && !error);
}
