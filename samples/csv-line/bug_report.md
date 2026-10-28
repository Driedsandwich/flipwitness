# Quoted commas split one field into two

The single line `pear,"red, green",plum` should give three fields:
`pear`, `red, green`, `plum`. The current splitter gives four.
Please remove enclosing quotes and handle a doubled quote inside a quoted
field as one literal quote. Empty fields, including a trailing empty field,
must be preserved. This helper only handles one line at a time.
