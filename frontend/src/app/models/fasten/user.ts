export class User {
  // The server's primary key, a uuid (models.ModelBase.ID). Needed by the admin password reset
  // (#511), which addresses the account by id rather than by name. Note `user_id` below is a
  // different, older field and is not this.
  id?: string
  user_id?: number
  full_name?: string
  username?: string
  email?: string
  password?: string
  role?: string
}
