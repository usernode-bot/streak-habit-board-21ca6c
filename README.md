# Streak Habit Board

A small personal habit tracker. Each habit shows a streak: how many days in
a row you have done it. Tap a habit to mark it done for today, tap it again
to undo.

- **One board, one job.** Habits still to do today come first, the ones
  already done below them. Each row has its name, its streak count ("9
  days") and one small flame for every day of the streak, up to 14.
- **Add and remove.** Type a name under "Add a habit" and tap Add. Tap Edit
  in the header to show Remove on each habit; removing asks for
  confirmation on the row first.
- **Streaks reset when a day is missed.** A streak counts consecutive marked
  days ending today, or ending yesterday when today is not marked yet. Miss
  a whole day and it goes back to 0.
- **Personal.** Habits belong to the person signed in through Homeroom. No
  one else in the group sees them.

The app runs on Homeroom. The platform supplies sign-in and the database;
`server.js` verifies the platform's identity token, stores habits in two
private Postgres tables (`habits`, `habit_days`) and serves the board from
`public/index.html`.

Open the staging preview with `?demo=1` to see a populated board of nine
sample habits, labelled "Staging demo".

See `CLAUDE.md` for the design notes and the platform rules.
