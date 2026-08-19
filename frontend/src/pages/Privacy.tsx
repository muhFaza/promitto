import { Link } from 'react-router-dom';
import { REPO_URL } from '../lib/repo';
import { useAuthStore } from '../stores/auth';

export function Privacy() {
  // This page is public, but most visitors arrive from the Settings link, so the
  // signed-in case is the common one — and /login would only bounce them to /app.
  const signedIn = useAuthStore((s) => s.user !== null);

  return (
    <main className="mx-auto max-w-2xl px-6 pb-24 pt-12">
      <header>
        <div className="eyebrow">Privacy</div>
        <h1 className="mt-2 font-display text-4xl italic leading-none text-ink sm:text-[44px]">
          What this server knows about you
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          Promitto schedules WhatsApp messages. It runs on one small virtual server rented
          and administered by one person, not a company. There is no support desk and no
          legal department. This page describes what that actually means for your data, in
          plain terms, including the parts that are not reassuring.
        </p>
      </header>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">
          The admin can read your messages
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Promitto sends messages at a time you pick, which is usually a time when you are
          not there. To do that, the server has to hold the text of your message in readable
          form until it is sent, and it keeps a copy of what it sent afterwards. There is no
          key that only you hold, because there would be nobody around to unlock it at
          send time.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          This is not end-to-end encrypted, and Promitto does not claim to be. The person
          who administers the server has full technical access to it: the database file, the
          WhatsApp session files, everything. They can read the text of your scheduled and
          sent messages, see who you scheduled them to, and see your contact list. Whether
          they do is a question of trust in that person, not of what the software prevents.
          Decide accordingly.
        </p>
      </section>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">Linking WhatsApp</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Pairing your phone links this server as a WhatsApp device on your account. That is
          the same level of access as WhatsApp Web: the server can send messages as you and
          receives your incoming messages while it is connected. Promitto only sends the
          messages you schedule, and it does not store incoming message content — but the
          access itself is real, and it is the same access any linked device has.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          You can end it at any time. Unlink the device from WhatsApp on your phone
          (Settings, Linked devices), or disconnect from the WhatsApp page here, or delete
          your account.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Disconnecting here and deleting your account both remove the stored pairing from
          this server and ask WhatsApp to unlink the device — but that request only reaches
          WhatsApp if the session is still connected at the time, and it is never allowed to
          hold up the deletion. If the connection had already dropped, the device can stay
          listed on your phone, and once the account is gone there is nothing here left to
          try again with. So check Linked devices on your phone afterwards. Removing it
          there always works, and is the one step that does not depend on this server.
        </p>
      </section>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">What is stored</h2>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-soft">
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">Your account.</span> The email address an
            administrator used to create it, and a hash of your password. Passwords are
            never stored in a readable form.
          </li>
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">Message text.</span> Everything you schedule, and a
            copy of everything that was sent, along with the recipient and the time. When a
            send fails, the error WhatsApp returned is stored with it so you can see why.
          </li>
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">Contacts.</span> Names and phone numbers, and whether
            the number was confirmed to be on WhatsApp. If contact syncing is on, these are
            copied from your WhatsApp address book when you pair, along with which chats you
            have pinned and roughly when you last interacted with each contact. You can turn
            syncing off and delete what was synced, in Settings.
          </li>
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">Your WhatsApp number.</span> Once you pair, the phone
            number of the linked account is stored with the connection, along with its
            current status and when it last connected.
          </li>
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">WhatsApp session files.</span> The credentials that
            keep the device link alive, on the server&rsquo;s disk. They also include a
            mapping of the WhatsApp accounts you have exchanged messages with — thousands of
            entries on an account that has been in use a while. That mapping is part of what
            lets the server address and decrypt those chats, so it is not something that can
            be pruned on its own, and turning contact syncing off does not touch it.
            Unlinking sets the whole set of files aside on the server; deleting your account
            removes them.
          </li>
          <li className="border-l-2 border-rule pl-4">
            <span className="text-ink">Login sessions.</span> A cookie, your browser&rsquo;s
            user agent string, and a coarse network prefix rather than your full IP address
            — enough to tell networks apart, not enough to point at a household. Each
            session also records when you signed in and when it was last used.
          </li>
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          Nothing about you is sent to any third party. There is no analytics, no
          advertising, no tracking script, and no data sharing. Fonts and the rest of the
          interface are served from this server rather than a CDN. There is one exception:
          contact profile pictures are held on WhatsApp&rsquo;s own servers, and this server
          points your browser at them rather than fetching and re-serving them, so opening a
          page that shows contacts makes your browser connect to WhatsApp directly. The
          server also asks GitHub every six hours whether a newer release of Promitto exists,
          so Settings can tell you whether this one is behind — that request carries nothing
          about you or your account, and your browser never makes it. Beyond those, the only
          outbound traffic is to WhatsApp itself.
        </p>
      </section>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">How long it is kept</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Sent history and finished one-off schedules are deleted permanently after a
          retention period you choose in Settings: 7, 30, 60, 90 or 180 days. The default is
          180 days. There is no unlimited option, on purpose.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Schedules that have not run yet and recurring schedules are live configuration, so
          they are kept until they finish or you cancel them. Contacts are kept until you
          delete them. You can wipe your message history at any time without waiting for the
          retention period.
        </p>
      </section>

      <hr className="my-10" />

      <section className="ledger-card border-l-2 border-l-accent-warm p-6">
        <h2 className="font-display text-2xl italic text-ink">
          There are no backups
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The server takes no backups of any kind. Deleting your account deletes your
          contacts, schedules, message history and WhatsApp pairing immediately and
          permanently — there is no copy anywhere to restore from, and no grace period in
          which the admin could undo it for you.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The same fact cuts the other way: if the server&rsquo;s disk fails, your data is
          gone and your account cannot be recovered. Promitto is not a place to keep
          anything you would be upset to lose.
        </p>
      </section>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">
          If you would rather not trust the admin
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Promitto is open source and runs as a single container with a SQLite file. You can
          host your own copy on your own machine, pair your own phone with it, and then the
          only person with access to the server is you. That is the honest answer to
          &ldquo;can I be sure nobody reads this&rdquo;, and no setting on someone
          else&rsquo;s server can substitute for it.
        </p>
        <p className="mt-4 text-sm leading-relaxed text-ink-soft">
          <a
            className="text-accent underline underline-offset-4 hover:text-ink"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            github.com/muhFaza/promitto
          </a>
        </p>
      </section>

      <hr className="my-10" />

      <section>
        <h2 className="font-display text-2xl italic text-ink">Questions</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Accounts here are handed out personally, so you already know who runs this server.
          Ask them directly — about anything on this page, or to have your account and
          everything in it removed.
        </p>
      </section>

      <div className="mt-12 flex items-center justify-between border-t border-rule pt-6">
        <Link
          className="text-[12px] text-ink-muted underline underline-offset-4 hover:text-ink"
          to={signedIn ? '/app' : '/login'}
        >
          {signedIn ? '← Back to Promitto' : '← Back to sign in'}
        </Link>
        <div className="eyebrow">one vps · one container · no saas</div>
      </div>
    </main>
  );
}
