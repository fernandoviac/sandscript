; Keywords
[
  "let"
  "const"
  "var"
  "function"
  "return"
  "throw"
  "if"
  "else"
  "while"
  "do"
  "for"
  "break"
  "continue"
  "try"
  "catch"
  "finally"
  "export"
  "new"
  "typeof"
  "instanceof"
  "async"
  "await"
  "of"
  "in"
] @keyword

; SandScript-only keywords
[
  "grant"
  "denied"
] @keyword

; Literal keywords
(true) @constant
(false) @constant
(null) @constant
(undefined) @constant
(this) @variable.special

; Functions
(function_declaration name: (identifier) @function)
(async_function_declaration name: (identifier) @function)
(function_expression name: (identifier) @function)
(async_function_expression name: (identifier) @function)
(method_definition name: (identifier) @function.method)
(call_expression function: (primary_expression (identifier) @function))
(call_expression function: (member_expression property: (identifier) @function.method))
(call_expression function: (optional_chain_expression property: (identifier) @function.method))

; Parameters
(formal_parameters (pattern (identifier) @variable.parameter))
(rest_pattern (identifier) @variable.parameter)
(catch_clause parameter: (identifier) @variable.parameter)
(denied_clause parameter: (identifier) @variable.parameter)

; Properties
(pair key: (identifier) @property)
(shorthand_property_identifier) @property
(pair_pattern key: (identifier) @property)
(member_expression property: (identifier) @property)
(optional_chain_expression property: (identifier) @property)

; Variables
(identifier) @variable

; Strings
(string) @string
(escape_sequence) @string.escape
(template_string) @string
(template_content) @string
(template_substitution "${" @punctuation.special "}" @punctuation.special)

; Numbers
(number) @number
(bigint) @number

; Comments
(comment) @comment

; Operators
(binary_expression operator: _ @operator)
(unary_expression operator: _ @operator)
(update_expression operator: _ @operator)
(assignment_expression operator: _ @operator)
(spread_expression "..." @operator)
(rest_pattern "..." @operator)
"=>" @operator
"?." @operator
"??" @operator

; Invalid — absent JS features, highlighted as errors
(invalid_loose_equality) @error
(invalid_loose_equality operator: _ @error)
(invalid_keyword) @error

; Punctuation
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," ";" "."] @punctuation.delimiter
"?" @punctuation.delimiter
":" @punctuation.delimiter
