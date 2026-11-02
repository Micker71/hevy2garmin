/**
 * A page in place of its data when the database does not answer. Rendering the page with empty
 * data instead would show an account with nothing in it, and that reads as lost data (#765).
 */
export function DatabaseDownPage({ title }: { title: string }) {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text">{title}</h1>
      </header>
      <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
        The database is not answering, so this page cannot show your data right now. Nothing is
        shown rather than an empty account. Try again in a few minutes.
      </div>
    </main>
  );
}
