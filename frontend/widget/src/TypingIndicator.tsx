export default function TypingIndicator() {
  return (
    <div className="csbot-typing flex items-center gap-1 px-4 py-3 mb-1 w-fit">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="csbot-dot w-2 h-2 rounded-full"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  );
}
