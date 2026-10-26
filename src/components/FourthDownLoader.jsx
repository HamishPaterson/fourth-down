export default function FourthDownLoader() {
  return (
    <div className="fourth-down-loader" role="status" aria-live="polite" aria-busy="true">
      <div className="fourth-down-loader-brand" aria-hidden="true">
        <span className="fourth-down-loader-mark">4D</span>
        <span>
          <strong>Fourth Down</strong>
          <small>NFL INTELLIGENCE</small>
        </span>
      </div>
      <img
        className="fourth-down-loader-animation"
        src="/loaders/football_spinning.webp"
        alt=""
        aria-hidden="true"
      />
      <div className="fourth-down-loader-reduced" aria-hidden="true">
        <span className="fourth-down-loader-mark">4D</span>
      </div>
      <span className="fourth-down-loader-label">Loading...</span>
    </div>
  );
}
