(function_declaration name: (identifier) @name) @item
(async_function_declaration name: (identifier) @name) @item
(variable_declaration (identifier) @name) @item
(export_declaration (function_declaration name: (identifier) @name)) @item
(export_declaration (async_function_declaration name: (identifier) @name)) @item
(export_declaration (variable_declaration (identifier) @name)) @item
(method_definition name: (identifier) @name) @item
(grant_statement) @item
